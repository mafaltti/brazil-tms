import { describe, expect, it } from "vitest";
import {
  createDocumentRequirementSchema,
  createDocumentTypeSchema,
} from "./document-requirement";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("createDocumentRequirementSchema", () => {
  it("defaults requiredForBilling true, requiredForCompletion false, active true", () => {
    const r = createDocumentRequirementSchema.parse({ customerId: UUID, documentTypeId: UUID });
    expect(r.requiredForBilling).toBe(true);
    expect(r.requiredForCompletion).toBe(false);
    expect(r.active).toBe(true);
  });
  it("accepts an optional vehicleType scope and rejects a bad one", () => {
    expect(
      createDocumentRequirementSchema.safeParse({
        customerId: UUID,
        documentTypeId: UUID,
        vehicleType: "truck",
      }).success,
    ).toBe(true);
    expect(
      createDocumentRequirementSchema.safeParse({
        customerId: UUID,
        documentTypeId: UUID,
        vehicleType: "spaceship",
      }).success,
    ).toBe(false);
  });
});

describe("createDocumentTypeSchema", () => {
  it("requires code + labelPt and defaults active true", () => {
    expect(createDocumentTypeSchema.safeParse({ code: "", labelPt: "X" }).success).toBe(false);
    expect(createDocumentTypeSchema.parse({ code: "pod", labelPt: "Comprovante" }).active).toBe(true);
  });
});
