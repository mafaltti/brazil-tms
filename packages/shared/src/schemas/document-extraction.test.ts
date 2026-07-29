import { describe, expect, it } from "vitest";
import {
  cnhExtractionSchema,
  crlvExtractionSchema,
  extractDocumentRequestSchema,
  EXTRACTION_MAX_IMAGE_BASE64_CHARS,
  EXTRACTION_MAX_IMAGE_BYTES,
  EXTRACTION_MAX_PDF_BASE64_CHARS,
  EXTRACTION_MAX_PDF_BYTES,
  unreadableFields,
} from "./document-extraction";

/** Pure unit tests for the 021 extraction schemas (FR-003 null-over-guess; request limits). */
describe("cnhExtractionSchema", () => {
  it("accepts a full read and a fully-unreadable read alike", () => {
    const full = {
      name: "João da Silva",
      licenseNumber: "12345678901",
      licenseCategory: "AE",
      licenseExpiry: "2028-05-01",
    };
    expect(cnhExtractionSchema.parse(full)).toEqual(full);
    const empty = { name: null, licenseNumber: null, licenseCategory: null, licenseExpiry: null };
    expect(cnhExtractionSchema.parse(empty)).toEqual(empty);
  });

  it("rejects a malformed date (the model must emit YYYY-MM-DD or null)", () => {
    expect(() =>
      cnhExtractionSchema.parse({
        name: "X",
        licenseNumber: null,
        licenseCategory: null,
        licenseExpiry: "01/05/2028",
      }),
    ).toThrow();
  });
});

describe("crlvExtractionSchema", () => {
  it("constrains vehicleType to the existing catalog (null when unmappable)", () => {
    expect(() =>
      crlvExtractionSchema.parse({ plate: "ABC1D23", vehicleType: "espacial", documentExpiry: null }),
    ).toThrow();
    expect(
      crlvExtractionSchema.parse({ plate: "ABC1D23", vehicleType: null, documentExpiry: null })
        .vehicleType,
    ).toBeNull();
  });
});

describe("extractDocumentRequestSchema", () => {
  it("accepts images and pdf; rejects unknown media types and empty payloads", () => {
    expect(
      extractDocumentRequestSchema.parse({ docType: "cnh", mediaType: "image/jpeg", data: "aGk=" })
        .docType,
    ).toBe("cnh");
    expect(() =>
      extractDocumentRequestSchema.parse({ docType: "cnh", mediaType: "text/plain", data: "aGk=" }),
    ).toThrow();
    expect(() =>
      extractDocumentRequestSchema.parse({ docType: "crlv", mediaType: "image/png", data: "" }),
    ).toThrow();
  });

  it("the encoded caps account for base64 padding (4 chars per started 3-byte block)", () => {
    expect(EXTRACTION_MAX_IMAGE_BASE64_CHARS).toBe(4 * Math.ceil(EXTRACTION_MAX_IMAGE_BYTES / 3));
    expect(EXTRACTION_MAX_IMAGE_BASE64_CHARS).toBe(10 * 1024 * 1024); // the Anthropic per-image cap
    expect(EXTRACTION_MAX_PDF_BASE64_CHARS).toBe(4 * Math.ceil(EXTRACTION_MAX_PDF_BYTES / 3));
    expect(EXTRACTION_MAX_PDF_BYTES).toBe(10 * 1024 * 1024); // the product's raw PDF limit
  });

  it("images: boundary at the ENCODED (base64) Anthropic cap — at-limit passes, above 400s", () => {
    const image = (data: string) =>
      extractDocumentRequestSchema.safeParse({ docType: "cnh", mediaType: "image/jpeg", data });

    expect(image("a".repeat(EXTRACTION_MAX_IMAGE_BASE64_CHARS)).success).toBe(true);

    // +4: base64 grows in whole 4-char blocks, so this is the smallest realistic oversize.
    const above = image("a".repeat(EXTRACTION_MAX_IMAGE_BASE64_CHARS + 4));
    expect(above.success).toBe(false);
    if (!above.success) {
      expect(above.error.issues[0]?.path).toEqual(["data"]);
      expect(above.error.issues[0]?.message).toContain("7,5 MB");
    }
  });

  it("pdf: boundary at 10 MiB RAW (padded encoding) — at-limit passes, above 400s", () => {
    const pdf = (data: string) =>
      extractDocumentRequestSchema.safeParse({ docType: "crlv", mediaType: "application/pdf", data });

    // Exactly 10 MiB of raw bytes encodes (with '==' padding) to exactly this many chars.
    expect(pdf("a".repeat(EXTRACTION_MAX_PDF_BASE64_CHARS)).success).toBe(true);

    const above = pdf("a".repeat(EXTRACTION_MAX_PDF_BASE64_CHARS + 4));
    expect(above.success).toBe(false);
    if (!above.success) expect(above.error.issues[0]?.message).toContain("10 MB");
  });

  it("is media-type-aware: a payload above the image cap but within the pdf cap flips on mediaType", () => {
    const between = "a".repeat(EXTRACTION_MAX_IMAGE_BASE64_CHARS + 4);
    expect(
      extractDocumentRequestSchema.safeParse({
        docType: "cnh",
        mediaType: "image/webp",
        data: between,
      }).success,
    ).toBe(false);
    expect(
      extractDocumentRequestSchema.safeParse({
        docType: "cnh",
        mediaType: "application/pdf",
        data: between,
      }).success,
    ).toBe(true);
  });
});

describe("unreadableFields", () => {
  it("lists exactly the null fields", () => {
    expect(unreadableFields({ a: null, b: "x", c: null })).toEqual(["a", "c"]);
    expect(unreadableFields({ a: "x" })).toEqual([]);
  });
});
