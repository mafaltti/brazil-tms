import { describe, expect, it } from "vitest";
import { createSlaRuleSchema, updateSlaRuleSchema } from "./customer-sla-rule";

/**
 * Unit tests for the per-customer SLA-rule Zod schemas (data-model §10). Minute fields are
 * non-negative integers; lane/vehicle-type/effective dates are optional; update requires ≥1 field.
 */

const UUID = "11111111-1111-1111-1111-111111111111";

const fullRule = {
  customerId: UUID,
  pickupToleranceMinutes: 15,
  deliveryToleranceMinutes: 30,
  confirmationCutoffMinutes: 90,
  atRiskWarningMinutes: 60,
};

describe("createSlaRuleSchema", () => {
  it("accepts the four minute fields + customer (optional scope/dates absent)", () => {
    const r = createSlaRuleSchema.parse(fullRule);
    expect(r.customerId).toBe(UUID);
    expect(r.pickupToleranceMinutes).toBe(15);
  });

  it("accepts optional lane/vehicleType/effective dates", () => {
    const r = createSlaRuleSchema.parse({
      ...fullRule,
      laneId: UUID,
      vehicleType: "truck",
      effectiveStart: "2026-01-01T00:00:00.000Z",
      effectiveEnd: "2026-12-31T00:00:00.000Z",
    });
    expect(r.laneId).toBe(UUID);
    expect(r.vehicleType).toBe("truck");
    expect(r.effectiveStart).toBeInstanceOf(Date);
  });

  it("rejects a negative or non-integer minute field", () => {
    expect(createSlaRuleSchema.safeParse({ ...fullRule, pickupToleranceMinutes: -1 }).success).toBe(
      false,
    );
    expect(createSlaRuleSchema.safeParse({ ...fullRule, atRiskWarningMinutes: 1.5 }).success).toBe(
      false,
    );
  });

  it("rejects a missing customer or an unknown vehicle type", () => {
    const { customerId, ...noCustomer } = fullRule;
    void customerId;
    expect(createSlaRuleSchema.safeParse(noCustomer).success).toBe(false);
    expect(createSlaRuleSchema.safeParse({ ...fullRule, vehicleType: "spaceship" }).success).toBe(
      false,
    );
  });
});

describe("updateSlaRuleSchema — ≥1 field present", () => {
  it("accepts a partial edit incl. active", () => {
    expect(updateSlaRuleSchema.safeParse({ active: false }).success).toBe(true);
    expect(updateSlaRuleSchema.safeParse({ pickupToleranceMinutes: 0 }).success).toBe(true);
  });

  it("rejects an empty edit", () => {
    expect(updateSlaRuleSchema.safeParse({}).success).toBe(false);
  });
});
