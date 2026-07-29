import { describe, expect, it } from "vitest";
import {
  createExceptionSchema,
  exceptionFilterSchema,
  transitionExceptionSchema,
  updateExceptionSchema,
} from "./exception";

/**
 * Unit tests for the exception Zod schemas (data-model §10). Required/optional fields, enum membership,
 * the closure-notes-required-on-Resolved superRefine, the ≥1-field update guard, and length caps.
 */

const UUID = "11111111-1111-1111-1111-111111111111";

describe("createExceptionSchema", () => {
  it("requires a reasonCodeId and accepts optional severity/responsible-party/owner/description", () => {
    const r = createExceptionSchema.parse({
      reasonCodeId: UUID,
      severity: "high",
      responsibleParty: "force_majeure",
      ownerUserId: UUID,
      description: "Pane no eixo.",
    });
    expect(r.reasonCodeId).toBe(UUID);
    expect(r.severity).toBe("high");
    expect(r.responsibleParty).toBe("force_majeure");
  });

  it("accepts a bare reasonCodeId (defaults pre-filled server-side)", () => {
    expect(createExceptionSchema.safeParse({ reasonCodeId: UUID }).success).toBe(true);
  });

  it("rejects a missing/invalid reason code and an unknown severity", () => {
    expect(createExceptionSchema.safeParse({}).success).toBe(false);
    expect(createExceptionSchema.safeParse({ reasonCodeId: "x" }).success).toBe(false);
    expect(createExceptionSchema.safeParse({ reasonCodeId: UUID, severity: "critical" }).success).toBe(
      false,
    );
  });

  it("rejects a description over 2000 chars", () => {
    const long = "a".repeat(2001);
    expect(createExceptionSchema.safeParse({ reasonCodeId: UUID, description: long }).success).toBe(
      false,
    );
  });
});

describe("updateExceptionSchema — ≥1 field present", () => {
  it("accepts a single-field edit", () => {
    expect(updateExceptionSchema.safeParse({ severity: "low" }).success).toBe(true);
    expect(updateExceptionSchema.safeParse({ ownerUserId: UUID }).success).toBe(true);
  });

  it("rejects an empty edit", () => {
    expect(updateExceptionSchema.safeParse({}).success).toBe(false);
  });
});

describe("transitionExceptionSchema — closure notes on Resolve", () => {
  it("requires closureNotes when toStatus is resolved", () => {
    expect(
      transitionExceptionSchema.safeParse({ expectedFromStatus: "open", toStatus: "resolved" })
        .success,
    ).toBe(false);
    expect(
      transitionExceptionSchema.safeParse({
        expectedFromStatus: "open",
        toStatus: "resolved",
        closureNotes: "Resolvido com o cliente.",
      }).success,
    ).toBe(true);
  });

  it("does NOT require closureNotes for monitoring/cancelled", () => {
    expect(
      transitionExceptionSchema.safeParse({ expectedFromStatus: "open", toStatus: "monitoring" })
        .success,
    ).toBe(true);
    expect(
      transitionExceptionSchema.safeParse({ expectedFromStatus: "open", toStatus: "cancelled" })
        .success,
    ).toBe(true);
  });

  it("rejects an unknown status value", () => {
    expect(
      transitionExceptionSchema.safeParse({ expectedFromStatus: "open", toStatus: "archived" })
        .success,
    ).toBe(false);
  });
});

describe("exceptionFilterSchema", () => {
  it("coerces minAgeHours/limit/offset and defaults paging", () => {
    const f = exceptionFilterSchema.parse({ minAgeHours: "24" });
    expect(f.minAgeHours).toBe(24);
    expect(f.limit).toBe(50);
    expect(f.offset).toBe(0);
  });

  it("treats blank filter params as absent", () => {
    const f = exceptionFilterSchema.parse({ severity: "", customerId: "" });
    expect(f.severity).toBeUndefined();
    expect(f.customerId).toBeUndefined();
  });
});
