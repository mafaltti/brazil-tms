import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  cnhExtractionSchema,
  crlvExtractionSchema,
  unreadableFields,
  VEHICLE_TYPE_VALUES,
  type CnhExtraction,
  type CrlvExtraction,
  type ExtractDocumentRequest,
} from "@brazil-tms/shared";

/**
 * AI document extraction (021, issue #29) — one vision call to the Claude API with a
 * schema-validated output, so the route gets typed fields or a typed failure, never free text.
 *
 * Privacy/ephemerality (FR-005): the base64 payload exists only in this request scope — it is sent
 * to the provider and discarded; NOTHING here may write it to disk, DB, Storage, or logs.
 * Key handling (FR-006): `ANTHROPIC_API_KEY` is read server-side only; when absent the feature is
 * dark (`ExtractionNotConfigured` → 503) and the manual forms are unaffected (FR-007).
 * Null-over-guess (FR-003): the schemas' fields are nullable and the prompt demands null for
 * anything unreadable — the UI lists those fields to the user.
 */

/** Thrown when no provider key is configured → 503 EXTRACTION_NOT_CONFIGURED. */
export class ExtractionNotConfigured extends Error {
  readonly code = "EXTRACTION_NOT_CONFIGURED";
  constructor() {
    super("Leitura de documentos não configurada. Contate um administrador.");
    this.name = "ExtractionNotConfigured";
  }
}

/** Thrown when the provider call fails or returns unparseable output → 502 EXTRACTION_FAILED. */
export class ExtractionFailed extends Error {
  readonly code = "EXTRACTION_FAILED";
  constructor(message = "Não foi possível ler o documento. Tente novamente.") {
    super(message);
    this.name = "ExtractionFailed";
  }
}

const MODEL = "claude-opus-4-8";
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Structured-output JSON Schemas (hand-written: the repo's classic zod v3 schemas can't feed the
 * SDK's zod-v4-typed helper, so the wire schema lives here and the SHARED zod schema still
 * validates the model's output — one source of validation truth, two representations).
 */
const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] } as const;
const OUTPUT_JSON_SCHEMAS: Record<ExtractDocumentRequest["docType"], Record<string, unknown>> = {
  cnh: {
    type: "object",
    additionalProperties: false,
    required: ["name", "licenseNumber", "licenseCategory", "licenseExpiry"],
    properties: {
      name: nullableString,
      licenseNumber: nullableString,
      licenseCategory: nullableString,
      licenseExpiry: nullableString,
    },
  },
  crlv: {
    type: "object",
    additionalProperties: false,
    required: ["plate", "vehicleType", "documentExpiry"],
    properties: {
      plate: nullableString,
      vehicleType: { anyOf: [{ type: "string", enum: [...VEHICLE_TYPE_VALUES] }, { type: "null" }] },
      documentExpiry: nullableString,
    },
  },
};

let cachedClient: Anthropic | null = null;

/** Lazy singleton over the env key; throws `ExtractionNotConfigured` when the key is absent. */
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) throw new ExtractionNotConfigured();
  cachedClient ??= new Anthropic();
  return cachedClient;
}

/** pt-BR extraction instructions per document type (null-over-guess is part of the contract). */
function buildPrompt(docType: ExtractDocumentRequest["docType"]): string {
  const common =
    "Você extrai campos de documentos brasileiros para pré-preencher um cadastro que será revisado " +
    "por um humano. Regras: retorne null em QUALQUER campo ilegível, ausente ou incerto — nunca " +
    "invente ou complete valores; datas sempre no formato YYYY-MM-DD.";
  if (docType === "cnh") {
    return (
      `${common} O documento é uma CNH (Carteira Nacional de Habilitação). Extraia: ` +
      `name = o nome completo do condutor como impresso; ` +
      `licenseNumber = o número de registro da habilitação; ` +
      `licenseCategory = a categoria de habilitação (ex.: AB, D, E); ` +
      `licenseExpiry = a data de validade da habilitação. ` +
      `Se a imagem não for uma CNH, retorne todos os campos como null.`
    );
  }
  return (
    `${common} O documento é um CRLV (Certificado de Registro e Licenciamento de Veículo). Extraia: ` +
    `plate = a placa em maiúsculas, sem hífen ou espaços; ` +
    `vehicleType = APENAS se a espécie/tipo do veículo corresponder claramente a um destes valores: ` +
    `${VEHICLE_TYPE_VALUES.join(", ")} — caso contrário null; ` +
    `documentExpiry = a validade do licenciamento (ou data limite do exercício), se impressa. ` +
    `Se a imagem não for um CRLV, retorne todos os campos como null.`
  );
}

export interface ExtractionOutcome {
  fields: CnhExtraction | CrlvExtraction;
  unreadable: string[];
}

/**
 * Run the extraction. `clientOverride` exists for unit tests (inject a fake — no network);
 * production always uses the env-keyed singleton.
 */
export async function extractDocument(
  input: ExtractDocumentRequest,
  clientOverride?: Anthropic,
): Promise<ExtractionOutcome> {
  const client = clientOverride ?? getClient();
  const schema = input.docType === "cnh" ? cnhExtractionSchema : crlvExtractionSchema;

  // Image vs PDF content block; the file always precedes the instruction text.
  const fileBlock =
    input.mediaType === "application/pdf"
      ? {
          type: "document" as const,
          source: {
            type: "base64" as const,
            media_type: "application/pdf" as const,
            data: input.data,
          },
        }
      : {
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: input.mediaType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
            data: input.data,
          },
        };

  try {
    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 2048,
        thinking: { type: "adaptive" },
        messages: [
          {
            role: "user",
            content: [fileBlock, { type: "text", text: buildPrompt(input.docType) }],
          },
        ],
        output_config: {
          format: {
            type: "json_schema",
            schema: OUTPUT_JSON_SCHEMAS[input.docType],
          },
        },
      },
      { timeout: REQUEST_TIMEOUT_MS },
    );

    if (response.stop_reason === "refusal") throw new ExtractionFailed();
    const text = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === "text",
    )?.text;
    if (!text) throw new ExtractionFailed();

    // The shared zod schema stays the single validation authority over the model's output.
    const parsed = schema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new ExtractionFailed();
    const fields = parsed.data as CnhExtraction | CrlvExtraction;
    return { fields, unreadable: unreadableFields(fields) };
  } catch (error) {
    if (error instanceof ExtractionFailed || error instanceof ExtractionNotConfigured) throw error;
    if (error instanceof Anthropic.AuthenticationError) {
      // Bad/revoked key is a configuration problem, not a user error.
      console.error("extract-document: provider authentication failed");
      throw new ExtractionNotConfigured();
    }
    if (error instanceof Anthropic.APIError) {
      // Never log the request payload (FR-005) — status/code only.
      console.error(`extract-document: provider error ${error.status ?? "?"}`);
      throw new ExtractionFailed();
    }
    console.error("extract-document: unexpected failure", error instanceof Error ? error.name : "");
    throw new ExtractionFailed();
  }
}
