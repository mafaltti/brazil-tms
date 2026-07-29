import { z } from "zod";
import { vehicleTypeSchema } from "./master-data";

/**
 * AI document reading (021, issue #29): schema-validated extraction of Brazilian registration
 * documents — CNH → driver form, CRLV → vehicle/trailer forms. Every extracted field is NULLABLE:
 * the model is instructed to return null for anything unreadable/absent, and the UI lists those
 * fields instead of guessing (FR-003). Dates are calendar dates as "YYYY-MM-DD" strings (the same
 * shape the expiry form fields use). Output is PREFILL-ONLY — it never reaches a create/update
 * service directly (FR-004).
 */

export const EXTRACTION_DOC_TYPES = ["cnh", "crlv"] as const;
export type ExtractionDocType = (typeof EXTRACTION_DOC_TYPES)[number];

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Data deve estar no formato YYYY-MM-DD.")
  .nullable();

/** CNH → the driver form's mapped fields. */
export const cnhExtractionSchema = z.object({
  /** Full name as printed on the CNH. */
  name: z.string().trim().min(1).nullable(),
  /** CNH registration number ("nº registro"). */
  licenseNumber: z.string().trim().min(1).nullable(),
  /** Category ("cat. hab."), e.g. "AB", "E". */
  licenseCategory: z.string().trim().min(1).nullable(),
  /** CNH validity ("validade") as YYYY-MM-DD. */
  licenseExpiry: isoDate,
});
export type CnhExtraction = z.infer<typeof cnhExtractionSchema>;

/** CRLV → the vehicle/trailer forms' mapped fields. */
export const crlvExtractionSchema = z.object({
  /** Plate, uppercase, no separators (e.g. "ABC1D23"). */
  plate: z.string().trim().min(1).nullable(),
  /** Only when the CRLV type clearly maps onto the existing catalog; otherwise null. */
  vehicleType: vehicleTypeSchema.nullable(),
  /** Licensing/document validity as YYYY-MM-DD. */
  documentExpiry: isoDate,
});
export type CrlvExtraction = z.infer<typeof crlvExtractionSchema>;

/** Accepted upload media types (images + PDF). */
export const EXTRACTION_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
] as const;
export type ExtractionMediaType = (typeof EXTRACTION_MEDIA_TYPES)[number];

/**
 * Size limits — media-type-aware, single source of truth for client AND server.
 *
 * Anthropic's vision API caps each IMAGE at 10 MB measured AFTER base64 encoding
 * (docs: build-with-claude/vision#request-limits), so for images the ENCODED payload is the
 * binding limit: 10 MiB of base64 chars ≙ 7.5 MiB raw (4 * ceil(n/3) chars for n raw bytes —
 * 7,864,320 * 4/3 = 10,485,760 exactly). PDFs are not under that per-image cap and keep the
 * product's original 10 MiB raw-file limit, whose padded encoding is 4 * ceil(10 MiB / 3) chars.
 */
export const EXTRACTION_MAX_IMAGE_BYTES = 7_864_320; // 7.5 MiB raw
export const EXTRACTION_MAX_IMAGE_BASE64_CHARS = 10_485_760; // = 4 * ceil(7_864_320 / 3), the Anthropic cap
export const EXTRACTION_MAX_PDF_BYTES = 10_485_760; // 10 MiB raw (unchanged product limit)
export const EXTRACTION_MAX_PDF_BASE64_CHARS = 13_981_016; // = 4 * ceil(10_485_760 / 3), padding included

/** Raw-byte cap for a picked file (client pre-check, before FileReader/fetch). */
export function extractionMaxBytes(mediaType: ExtractionMediaType): number {
  return mediaType === "application/pdf" ? EXTRACTION_MAX_PDF_BYTES : EXTRACTION_MAX_IMAGE_BYTES;
}

/** Encoded (base64 chars) cap for the request payload (authoritative server check). */
export function extractionMaxBase64Chars(mediaType: ExtractionMediaType): number {
  return mediaType === "application/pdf"
    ? EXTRACTION_MAX_PDF_BASE64_CHARS
    : EXTRACTION_MAX_IMAGE_BASE64_CHARS;
}

/** Oversize message per media type (pt-BR, mirrored by the client's pre-check message). */
export function extractionTooLargeMessage(mediaType: ExtractionMediaType): string {
  return mediaType === "application/pdf"
    ? "Arquivo muito grande (máximo 10 MB para PDF)."
    : "Imagem muito grande (máximo 7,5 MB).";
}

/** Request body for POST /api/master-data/extract-document. */
export const extractDocumentRequestSchema = z
  .object({
    docType: z.enum(EXTRACTION_DOC_TYPES),
    mediaType: z.enum(EXTRACTION_MEDIA_TYPES),
    /** Base64 payload WITHOUT a data-URL prefix. Ephemeral — never persisted (FR-005). */
    data: z.string().min(1, "Envie o arquivo do documento."),
  })
  .superRefine((body, ctx) => {
    // Media-type-aware: an encoded image above Anthropic's 10 MiB-encoded cap must 400 here,
    // never reach the provider (it would come back as an opaque 502 EXTRACTION_FAILED).
    if (body.data.length > extractionMaxBase64Chars(body.mediaType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["data"],
        message: extractionTooLargeMessage(body.mediaType),
      });
    }
  });
export type ExtractDocumentRequest = z.infer<typeof extractDocumentRequestSchema>;

/** Route response: the extracted fields + which mapped fields could not be read (pt-BR labels are the UI's job). */
export interface ExtractDocumentResult<T> {
  fields: T;
  /** Keys of `fields` that came back null — shown to the user as "não lidos" (FR-003). */
  unreadable: string[];
}

/** List the null fields of an extraction (the `unreadable` payload). */
export function unreadableFields(fields: Record<string, unknown>): string[] {
  return Object.entries(fields)
    .filter(([, value]) => value === null)
    .map(([key]) => key);
}
