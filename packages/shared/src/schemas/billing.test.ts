import { describe, expect, it } from "vitest";
import {
  addBillingAdjustmentSchema,
  createExportSchema,
  markCompletedSchema,
  updateBillingItemSchema,
} from "./billing";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("addBillingAdjustmentSchema", () => {
  it("accepts a typed adjustment and rejects an unknown type", () => {
    expect(addBillingAdjustmentSchema.parse({ type: "toll", amountCents: 500 }).amountCents).toBe(500);
    expect(addBillingAdjustmentSchema.safeParse({ type: "tip", amountCents: 500 }).success).toBe(false);
  });
});

describe("updateBillingItemSchema", () => {
  it("validates the YYYY-MM billing period and the dispute-status enum", () => {
    expect(updateBillingItemSchema.safeParse({ billingPeriod: "2026-05" }).success).toBe(true);
    expect(updateBillingItemSchema.safeParse({ billingPeriod: "2026-5" }).success).toBe(false);
    expect(updateBillingItemSchema.safeParse({ disputeStatus: "frozen" }).success).toBe(false);
  });
});

describe("markCompletedSchema", () => {
  it("accepts an optional waivedRequirements array", () => {
    const r = markCompletedSchema.parse({
      waivedRequirements: [{ documentTypeId: UUID, reason: "perdido" }],
    });
    expect(r.waivedRequirements).toHaveLength(1);
    expect(markCompletedSchema.parse({}).waivedRequirements).toBeUndefined();
  });
  it("rejects a waiver with an empty reason", () => {
    expect(
      markCompletedSchema.safeParse({ waivedRequirements: [{ documentTypeId: UUID, reason: "" }] })
        .success,
    ).toBe(false);
  });
});

describe("createExportSchema", () => {
  it("requires customer + YYYY-MM period + a valid format", () => {
    expect(
      createExportSchema.parse({ customerId: UUID, billingPeriod: "2026-05", format: "xlsx" }).format,
    ).toBe("xlsx");
    expect(
      createExportSchema.safeParse({ customerId: UUID, billingPeriod: "2026-05", format: "pdf" })
        .success,
    ).toBe(false);
  });
});
