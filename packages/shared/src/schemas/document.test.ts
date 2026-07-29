import { describe, expect, it } from "vitest";
import { uploadDocumentMetaSchema, verifyDocumentSchema } from "./document";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("uploadDocumentMetaSchema", () => {
  it("accepts a valid meta and trims optionals", () => {
    const r = uploadDocumentMetaSchema.parse({
      documentTypeId: UUID,
      fileName: "pod.pdf",
      externalReference: " CTE-1 ",
    });
    expect(r.externalReference).toBe("CTE-1");
  });
  it("requires a uuid documentTypeId and a non-empty fileName", () => {
    expect(uploadDocumentMetaSchema.safeParse({ documentTypeId: "x", fileName: "a.pdf" }).success).toBe(
      false,
    );
    expect(uploadDocumentMetaSchema.safeParse({ documentTypeId: UUID, fileName: "" }).success).toBe(
      false,
    );
  });
});

describe("verifyDocumentSchema", () => {
  it("accepts a valid verification status", () => {
    expect(verifyDocumentSchema.parse({ verificationStatus: "accepted" }).verificationStatus).toBe(
      "accepted",
    );
  });
  it("rejects an unknown status (waived is NOT a verification status)", () => {
    expect(verifyDocumentSchema.safeParse({ verificationStatus: "waived" }).success).toBe(false);
  });
});
