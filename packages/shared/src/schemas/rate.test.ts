import { describe, expect, it } from "vitest";
import { createRateSchema } from "./rate";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("createRateSchema", () => {
  it("accepts a customer-default rate with cents + the BRL default", () => {
    const r = createRateSchema.parse({ customerId: UUID, baseAmountCents: 150_000 });
    expect(r.currency).toBe("BRL");
    expect(r.active).toBe(true);
  });
  it("coerces effective dates and rejects negative / non-integer amounts", () => {
    const r = createRateSchema.parse({
      customerId: UUID,
      baseAmountCents: 1000,
      effectiveStart: "2026-01-01",
    });
    expect(r.effectiveStart).toBeInstanceOf(Date);
    expect(createRateSchema.safeParse({ customerId: UUID, baseAmountCents: -1 }).success).toBe(false);
    expect(createRateSchema.safeParse({ customerId: UUID, baseAmountCents: 1.5 }).success).toBe(false);
  });
});
