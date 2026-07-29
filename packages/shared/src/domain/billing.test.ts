import { describe, expect, it } from "vitest";
import {
  BILLING_ADJUSTMENT_TYPES,
  computeBillingValues,
  evaluateBillingReadiness,
  evaluateCompletionReadiness,
  EXPORT_BATCH_STATUSES,
  EXPORT_FORMATS,
} from "./billing";

/** Feature 008 — pure billing vocab + value computation + the two gate evaluators (data-model §9.2). */

describe("value-set constants", () => {
  it("BILLING_ADJUSTMENT_TYPES is the seven addable types", () => {
    expect([...BILLING_ADJUSTMENT_TYPES]).toEqual([
      "toll",
      "waiting_time",
      "redelivery",
      "extra_stop",
      "penalty",
      "discount",
      "manual_adjustment",
    ]);
  });
  it("EXPORT_FORMATS is csv + xlsx", () => {
    expect([...EXPORT_FORMATS]).toEqual(["csv", "xlsx"]);
  });
  it("EXPORT_BATCH_STATUSES mirrors import_batch_status", () => {
    expect([...EXPORT_BATCH_STATUSES]).toEqual(["queued", "running", "completed", "failed"]);
  });
});

describe("computeBillingValues", () => {
  it("returns null final when the base freight is null (unpriced)", () => {
    const v = computeBillingValues(null, [{ type: "toll", amountCents: 500 }]);
    expect(v.plannedCents).toBeNull();
    expect(v.executedCents).toBeNull();
    expect(v.adjustmentCents).toBe(500);
    expect(v.finalBillableCents).toBeNull();
  });

  it("adds tolls/extras/penalties, subtracts discounts, signs manual", () => {
    const v = computeBillingValues(100_00, [
      { type: "toll", amountCents: 10_00 },
      { type: "extra_stop", amountCents: 5_00 },
      { type: "penalty", amountCents: 8_00 },
      { type: "discount", amountCents: 3_00 },
      { type: "manual_adjustment", amountCents: -2_00 },
    ]);
    // 100 + 10 + 5 + 8 - 3 - 2 = 118 reais
    expect(v.executedCents).toBe(100_00);
    expect(v.adjustmentCents).toBe(10_00 + 5_00 + 8_00 - 3_00 - 2_00);
    expect(v.finalBillableCents).toBe(118_00);
  });

  it("final == executed when there are no adjustments", () => {
    const v = computeBillingValues(250_00, []);
    expect(v.adjustmentCents).toBe(0);
    expect(v.finalBillableCents).toBe(250_00);
  });
});

describe("evaluateCompletionReadiness (§19.3)", () => {
  it("passes from unloaded with no missing completion docs", () => {
    const r = evaluateCompletionReadiness({
      currentStatus: "unloaded",
      completionMissingDocuments: 0,
    });
    expect(r.canComplete).toBe(true);
    expect(r.blockers).toEqual([]);
  });
  it("blocks when not unloaded", () => {
    const r = evaluateCompletionReadiness({
      currentStatus: "in_transit",
      completionMissingDocuments: 0,
    });
    expect(r.canComplete).toBe(false);
    expect(r.blockers).toContain("not_unloaded");
  });
  it("blocks cancelled with the cancelled blocker (not not_unloaded)", () => {
    const r = evaluateCompletionReadiness({
      currentStatus: "cancelled",
      completionMissingDocuments: 0,
    });
    expect(r.blockers).toContain("cancelled");
    expect(r.blockers).not.toContain("not_unloaded");
  });
  it("blocks on missing completion documents", () => {
    const r = evaluateCompletionReadiness({
      currentStatus: "unloaded",
      completionMissingDocuments: 2,
    });
    expect(r.canComplete).toBe(false);
    expect(r.blockers).toContain("missing_completion_documents");
  });
});

describe("evaluateBillingReadiness (§19.4)", () => {
  const base = {
    currentStatus: "billing_pending" as const,
    billingMissingDocuments: 0,
    hasPricing: true,
    disputeStatus: "none" as const,
  };
  it("passes when billing_pending, docs satisfied, priced, no open dispute", () => {
    const r = evaluateBillingReadiness(base);
    expect(r.canBillReady).toBe(true);
    expect(r.blockers).toEqual([]);
  });
  it("blocks when not in billing_pending", () => {
    expect(evaluateBillingReadiness({ ...base, currentStatus: "completed" }).blockers).toContain(
      "not_billing_pending",
    );
  });
  it("blocks on missing billing documents", () => {
    expect(evaluateBillingReadiness({ ...base, billingMissingDocuments: 1 }).blockers).toContain(
      "missing_billing_documents",
    );
  });
  it("blocks when unpriced", () => {
    expect(evaluateBillingReadiness({ ...base, hasPricing: false }).blockers).toContain("no_pricing");
  });
  it("blocks on an open billing dispute", () => {
    expect(evaluateBillingReadiness({ ...base, disputeStatus: "open" }).blockers).toContain(
      "open_billing_dispute",
    );
  });
  it("does not block on a resolved dispute", () => {
    expect(evaluateBillingReadiness({ ...base, disputeStatus: "resolved" }).canBillReady).toBe(true);
  });
});
