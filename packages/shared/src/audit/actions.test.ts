import { describe, expect, it } from "vitest";
import { ALL_AUDIT_ACTIONS, type AuditAction } from "./actions";

/**
 * Unit tests for the typed audit-action catalog. The `satisfies readonly AuditAction[]` clause already
 * pins the union ⇄ array lockstep at compile time; these runtime checks guard the feature 006 additions
 * and the no-duplicate / global-audit-screen invariants (research §8).
 */

describe("ALL_AUDIT_ACTIONS", () => {
  it("contains the four feature 006 dispatch-assignment actions", () => {
    for (const action of [
      "trip.assign",
      "trip.reassign",
      "trip.unassign",
      "trip.confirm",
    ] as const) {
      expect(ALL_AUDIT_ACTIONS).toContain<AuditAction>(action);
    }
  });

  it("contains the seven feature 007 execution/exception/SLA-rule actions", () => {
    for (const action of [
      "exception.create",
      "exception.update",
      "exception.resolve",
      "exception.cancel",
      "trip.note",
      "sla_rule.create",
      "sla_rule.update",
    ] as const) {
      expect(ALL_AUDIT_ACTIONS).toContain<AuditAction>(action);
    }
  });

  it("contains the twelve feature 008 document/rate/billing/export actions", () => {
    for (const action of [
      "document.upload",
      "document.verify",
      "document.waive",
      "document.archive",
      "document_requirement.create",
      "document_requirement.update",
      "document_type.create",
      "document_type.update",
      "rate.create",
      "rate.update",
      "billing_item.update",
      "billing.export",
    ] as const) {
      expect(ALL_AUDIT_ACTIONS).toContain<AuditAction>(action);
    }
  });

  it("does NOT add a completion/billing-ready action (those reuse trip.status_change)", () => {
    expect(ALL_AUDIT_ACTIONS).toContain<AuditAction>("trip.status_change");
    expect(ALL_AUDIT_ACTIONS).not.toContain("trip.complete" as AuditAction);
    expect(ALL_AUDIT_ACTIONS).not.toContain("trip.billing_ready" as AuditAction);
  });

  it("has no duplicate entries", () => {
    expect(new Set(ALL_AUDIT_ACTIONS).size).toBe(ALL_AUDIT_ACTIONS.length);
  });
});
