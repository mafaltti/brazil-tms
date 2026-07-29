import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { ExtractionFailed, extractDocument } from "./extract-document";

/**
 * Unit tests for the 021 extraction service with an INJECTED fake client — no network, no key.
 * (The not-configured path and permission gate are covered by the route e2e; live extraction is
 * the quickstart's manual step with a real key.)
 */

interface CapturedParams {
  model: string;
  thinking?: { type: string };
  output_config?: { format?: { type?: string; schema?: Record<string, unknown> } };
  messages: Array<{
    content: Array<{ type: string; text?: string; source?: { media_type?: string } }>;
  }>;
}

function fakeClient(createImpl: (params: CapturedParams) => Promise<unknown>): Anthropic {
  return { messages: { create: createImpl } } as unknown as Anthropic;
}

function textResponse(payload: unknown, stopReason = "end_turn"): unknown {
  return {
    stop_reason: stopReason,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

const cnhRequest = {
  docType: "cnh",
  mediaType: "image/jpeg",
  data: "aGVsbG8=",
} as const;

const fullCnh = {
  name: "João da Silva Souza",
  licenseNumber: "12345678901",
  licenseCategory: "AE",
  licenseExpiry: null,
};

describe("extractDocument (fake client)", () => {
  it("returns schema-validated fields and lists null fields as unreadable", async () => {
    const client = fakeClient(async () => textResponse(fullCnh));
    const result = await extractDocument(cnhRequest, client);
    expect(result.fields).toEqual(fullCnh);
    expect(result.unreadable).toEqual(["licenseExpiry"]);
  });

  it("sends the image before the pt-BR instruction and requests json_schema output with adaptive thinking", async () => {
    let captured: CapturedParams | null = null;
    const client = fakeClient(async (params) => {
      captured = params;
      return textResponse(fullCnh);
    });
    await extractDocument(cnhRequest, client);
    const params = captured!;
    const content = params.messages[0]!.content;
    expect(content[0]!.type).toBe("image");
    expect(content[0]!.source?.media_type).toBe("image/jpeg");
    expect(content[1]!.type).toBe("text");
    expect(content[1]!.text).toContain("CNH");
    expect(content[1]!.text).toContain("null");
    expect(params.output_config?.format?.type).toBe("json_schema");
    expect(params.thinking).toEqual({ type: "adaptive" });
  });

  it("uses a document block for PDFs and the CRLV prompt/schema for crlv", async () => {
    let captured: CapturedParams | null = null;
    const client = fakeClient(async (params) => {
      captured = params;
      return textResponse({ plate: "ABC1D23", vehicleType: null, documentExpiry: "2026-12-31" });
    });
    const result = await extractDocument(
      { docType: "crlv", mediaType: "application/pdf", data: "aGVsbG8=" },
      client,
    );
    const params = captured!;
    expect(params.messages[0]!.content[0]!.type).toBe("document");
    expect(params.messages[0]!.content[1]!.text).toContain("CRLV");
    expect(result.unreadable).toEqual(["vehicleType"]);
  });

  it("rejects output that fails the SHARED zod schema (bad date) as ExtractionFailed", async () => {
    const client = fakeClient(async () =>
      textResponse({ ...fullCnh, licenseExpiry: "01/05/2028" }),
    );
    await expect(extractDocument(cnhRequest, client)).rejects.toBeInstanceOf(ExtractionFailed);
  });

  it("maps a refusal stop_reason to ExtractionFailed", async () => {
    const client = fakeClient(async () => textResponse(fullCnh, "refusal"));
    await expect(extractDocument(cnhRequest, client)).rejects.toBeInstanceOf(ExtractionFailed);
  });

  it("maps non-JSON output and provider failures to ExtractionFailed", async () => {
    const badText = fakeClient(async () => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "não consegui ler" }],
    }));
    await expect(extractDocument(cnhRequest, badText)).rejects.toBeInstanceOf(ExtractionFailed);

    const network = fakeClient(async () => {
      throw new Error("network down");
    });
    await expect(extractDocument(cnhRequest, network)).rejects.toBeInstanceOf(ExtractionFailed);
  });
});
