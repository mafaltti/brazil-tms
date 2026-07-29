import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCUMENT_CHECKLIST,
  DOCUMENT_VERIFICATION_STATUSES,
  evaluateChecklist,
  type RequiredType,
} from "./documents";

/** Feature 008 — pure document-checklist evaluator (data-model §9.1). No DB. */

describe("DOCUMENT_VERIFICATION_STATUSES", () => {
  it("is the fixed three-value set", () => {
    expect([...DOCUMENT_VERIFICATION_STATUSES]).toEqual(["pending_review", "accepted", "rejected"]);
  });
});

describe("DEFAULT_DOCUMENT_CHECKLIST", () => {
  it("is labeled scaffolding: POD required for billing, not completion", () => {
    expect(DEFAULT_DOCUMENT_CHECKLIST).toHaveLength(1);
    expect(DEFAULT_DOCUMENT_CHECKLIST[0]).toEqual({
      typeCode: "pod",
      requiredForCompletion: false,
      requiredForBilling: true,
    });
  });
});

describe("evaluateChecklist", () => {
  const required: RequiredType[] = [
    { documentTypeId: "t-pod", requiredForCompletion: true, requiredForBilling: true },
    { documentTypeId: "t-cte", requiredForCompletion: false, requiredForBilling: true },
    { documentTypeId: "t-gate", requiredForCompletion: false, requiredForBilling: false },
  ];

  it("reports completion-missing vs billing-missing given the satisfied set", () => {
    const { completionMissing, billingMissing } = evaluateChecklist(required, new Set());
    expect(completionMissing).toEqual(["t-pod"]);
    expect(billingMissing).toEqual(["t-pod", "t-cte"]);
  });

  it("clears a type once it is satisfied (accepted or waived)", () => {
    const { completionMissing, billingMissing } = evaluateChecklist(required, new Set(["t-pod"]));
    expect(completionMissing).toEqual([]);
    expect(billingMissing).toEqual(["t-cte"]);
  });

  it("reports nothing when all required types are satisfied", () => {
    const { completionMissing, billingMissing } = evaluateChecklist(
      required,
      new Set(["t-pod", "t-cte"]),
    );
    expect(completionMissing).toEqual([]);
    expect(billingMissing).toEqual([]);
  });
});
