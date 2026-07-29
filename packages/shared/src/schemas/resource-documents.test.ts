import { describe, expect, it } from "vitest";
import {
  RESOURCE_DOCUMENT_ENTITY_TYPES,
  RESOURCE_DOCUMENT_TYPE_SUGGESTIONS,
  uploadResourceDocumentMetaSchema,
} from "./resource-documents";

/** Slice 025 — upload meta contract (free-text type, 1–60 after trim). */
describe("uploadResourceDocumentMetaSchema", () => {
  it("accepts a trimmed free-text type", () => {
    expect(uploadResourceDocumentMetaSchema.parse({ docType: "  CNH digital  " }).docType).toBe(
      "CNH digital",
    );
  });

  it("rejects empty and over-60-char types", () => {
    expect(uploadResourceDocumentMetaSchema.safeParse({ docType: "   " }).success).toBe(false);
    expect(uploadResourceDocumentMetaSchema.safeParse({ docType: "a".repeat(61) }).success).toBe(
      false,
    );
    expect(uploadResourceDocumentMetaSchema.safeParse({ docType: "a".repeat(60) }).success).toBe(
      true,
    );
  });

  it("every entity type has UI suggestions", () => {
    for (const entityType of RESOURCE_DOCUMENT_ENTITY_TYPES) {
      expect(RESOURCE_DOCUMENT_TYPE_SUGGESTIONS[entityType].length).toBeGreaterThan(0);
    }
  });
});
