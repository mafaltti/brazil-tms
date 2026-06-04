import { describe, expect, it } from "vitest";
import {
  ALL_AUDIT_ACTIONS,
  BILLING_PHASE_STATUSES,
  EXCEPTION_SEVERITIES,
  REASON_CODE_CATEGORIES,
} from "@brazil-tms/shared";
import messages from "../messages/pt-BR.json";

/**
 * Guard: next-intl forbids "." inside a message key (it is the nesting separator) and throws
 * `INVALID_KEY` at `getMessages()` — which breaks EVERY page render via RootLayout. Trip audit
 * actions are dotted strings (`trip.plan_update`), so they MUST be nested objects, not literal dotted
 * keys. This walks the whole catalog and fails on any key containing a dot. Pure unit — no DB.
 */
function dottedKeys(value: unknown, path = ""): string[] {
  if (value === null || typeof value !== "object") return [];
  const bad: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    if (key.includes(".")) bad.push(here);
    bad.push(...dottedKeys(child, here));
  }
  return bad;
}

describe("pt-BR messages", () => {
  it("has no message key containing '.' (next-intl nesting separator)", () => {
    expect(dottedKeys(messages)).toEqual([]);
  });

  it("resolves nested trip audit actions via the dot-path lookup", () => {
    const auditActions = (messages as { Trips: { auditActions: Record<string, unknown> } }).Trips
      .auditActions;
    expect((auditActions.trip as Record<string, string>).plan_update).toBe("Plano atualizado");
  });

  it("has nested + flat labels for the 006 dispatch-assignment trip actions", () => {
    const trip = (messages as { Trips: { auditActions: { trip: Record<string, string> } } }).Trips
      .auditActions.trip;
    const flat = (messages as { AuditActions: Record<string, string> }).AuditActions;
    for (const action of ["assign", "reassign", "unassign", "confirm"] as const) {
      // nested resolution (next-intl dot-path) ...
      expect(typeof trip[action]).toBe("string");
      expect(trip[action]).not.toBe("");
      // ... and the flat `AuditActions` label the global audit screen looks up via `_`.
      expect(typeof flat[`trip_${action}`]).toBe("string");
      expect(flat[`trip_${action}`]).not.toBe("");
    }
  });

  it("has nested + flat labels for the 007 exception / note / sla_rule actions", () => {
    const trip = (messages as { Trips: { auditActions: { trip: Record<string, string> } } }).Trips
      .auditActions.trip;
    const exception = (
      messages as { Trips: { auditActions: { exception: Record<string, string> } } }
    ).Trips.auditActions.exception;
    const slaRule = (messages as { Trips: { auditActions: { sla_rule: Record<string, string> } } })
      .Trips.auditActions.sla_rule;
    const flat = (messages as { AuditActions: Record<string, string> }).AuditActions;

    // nested resolution (next-intl dot-path) for the 007 additions ...
    expect(typeof trip.note).toBe("string");
    for (const a of ["create", "update", "resolve", "cancel"] as const) {
      expect(typeof exception[a]).toBe("string");
      expect(exception[a]).not.toBe("");
    }
    for (const a of ["create", "update"] as const) {
      expect(typeof slaRule[a]).toBe("string");
      expect(slaRule[a]).not.toBe("");
    }
    // ... and the flat `AuditActions` labels the global audit screen looks up via `_`.
    for (const key of [
      "exception_create",
      "exception_update",
      "exception_resolve",
      "exception_cancel",
      "trip_note",
      "sla_rule_create",
      "sla_rule_update",
    ] as const) {
      expect(typeof flat[key]).toBe("string");
      expect(flat[key]).not.toBe("");
    }
  });

  it("has nested + flat labels for the 008 document / requirement / type / rate / billing actions", () => {
    const a = (
      messages as {
        Trips: {
          auditActions: {
            document: Record<string, string>;
            document_requirement: Record<string, string>;
            document_type: Record<string, string>;
            rate: Record<string, string>;
            billing_item: Record<string, string>;
            billing: Record<string, string>;
          };
        };
      }
    ).Trips.auditActions;
    const flat = (messages as { AuditActions: Record<string, string> }).AuditActions;

    // Nested resolution (next-intl dot-path) for the twelve 008 additions.
    for (const k of ["upload", "verify", "waive", "archive"] as const) {
      expect(a.document[k]).toBeTruthy();
    }
    for (const k of ["create", "update"] as const) {
      expect(a.document_requirement[k]).toBeTruthy();
      expect(a.document_type[k]).toBeTruthy();
      expect(a.rate[k]).toBeTruthy();
    }
    expect(a.billing_item.update).toBeTruthy();
    expect(a.billing.export).toBeTruthy();

    // Flat `AuditActions` (global audit screen lookup via action.replaceAll('.','_')).
    for (const key of [
      "document_upload",
      "document_verify",
      "document_waive",
      "document_archive",
      "document_requirement_create",
      "document_requirement_update",
      "document_type_create",
      "document_type_update",
      "rate_create",
      "rate_update",
      "billing_item_update",
      "billing_export",
    ] as const) {
      expect(typeof flat[key]).toBe("string");
      expect(flat[key]).not.toBe("");
    }
  });

  it("has an AuditActions label for EVERY audit action (global screen uses action.replaceAll('.','_'))", () => {
    const labels = (messages as { AuditActions: Record<string, string> }).AuditActions;
    const missing = ALL_AUDIT_ACTIONS.filter((action) => {
      const key = action.replaceAll(".", "_");
      return typeof labels[key] !== "string" || labels[key] === "";
    });
    expect(missing).toEqual([]);
  });

  // ---- feature 009 — Reports + AuditView localization coverage (FR-018 / SC-006) -----------------

  it("has the 009 Reports and AuditView namespaces", () => {
    const m = messages as Record<string, unknown>;
    expect(typeof m.Reports).toBe("object");
    expect(typeof m.AuditView).toBe("object");
    expect((m as { Nav: Record<string, string> }).Nav.reports).toBeTruthy();
  });

  it("Reports has the screen-shell keys the components look up", () => {
    const r = (messages as { Reports: Record<string, Record<string, string> | string> }).Reports;
    for (const k of ["title", "subtitle", "period", "provisionalLabel", "loadError", "empty"]) {
      expect(typeof r[k]).toBe("string");
      expect(r[k]).not.toBe("");
    }
    const tabs = r.tabs as Record<string, string>;
    for (const k of ["sla", "exceptions", "billingReadiness"]) expect(tabs[k]).toBeTruthy();
    const filters = r.filters as Record<string, string>;
    for (const k of ["customer", "lane", "from", "to", "groupBy", "all", "clear"]) {
      expect(filters[k]).toBeTruthy();
    }
  });

  it("Reports.categoryValue covers every reason-code category (no raw token in the exception report)", () => {
    const cat = (messages as { Reports: { categoryValue: Record<string, string> } }).Reports
      .categoryValue;
    const missing = REASON_CODE_CATEGORIES.filter((c) => typeof cat[c] !== "string" || cat[c] === "");
    expect(missing).toEqual([]);
  });

  it("Reports.severityValue covers every exception severity", () => {
    const sev = (messages as { Reports: { severityValue: Record<string, string> } }).Reports
      .severityValue;
    const missing = EXCEPTION_SEVERITIES.filter((s) => typeof sev[s] !== "string" || sev[s] === "");
    expect(missing).toEqual([]);
  });

  it("Reports.billing covers every billing-phase status", () => {
    const billing = (messages as { Reports: { billing: Record<string, string> } }).Reports.billing;
    const missing = BILLING_PHASE_STATUSES.filter(
      (s) => typeof billing[s] !== "string" || billing[s] === "",
    );
    expect(missing).toEqual([]);
    for (const k of ["completedMissingDocuments", "pctReadyWithin24h", "customer"]) {
      expect(billing[k]).toBeTruthy();
    }
  });

  it("AuditView covers the §21.5 entity-type presets the audit screen renders", () => {
    const view = (messages as { AuditView: { presets: Record<string, string> } }).AuditView;
    for (const k of ["all", "trip", "exception", "document", "billing", "export", "user"]) {
      expect(view.presets[k]).toBeTruthy();
    }
  });

  // ---- feature 010 — Validate action + NOT_ASSIGNABLE localization (#11) -------------------------

  it("Dispatch.errors has the NOT_ASSIGNABLE label (so the assign error is not REQUEST_FAILED)", () => {
    const errors = (messages as { Dispatch: { errors: Record<string, string> } }).Dispatch.errors;
    expect(typeof errors.NOT_ASSIGNABLE).toBe("string");
    expect(errors.NOT_ASSIGNABLE).not.toBe("");
  });

  it("Trips.detail has the Validate action keys the ValidateAction component looks up", () => {
    const d = (messages as { Trips: { detail: Record<string, unknown> } }).Trips.detail;
    for (const k of [
      "validateSectionTitle",
      "validateHint",
      "validateAction",
      "rejectAction",
      "rejectReasonLabel",
      "rejectReasonPlaceholder",
      "rejectReasonRequired",
      "revertHint",
      "revertToReceived",
      "validating",
    ]) {
      expect(typeof d[k]).toBe("string");
      expect(d[k]).not.toBe("");
    }
  });

  // ---- feature 012 — Import Template Administration localization (FR-014 / SC coverage) -----------

  it("ImportTemplates has the four pt-BR target-kind group headers (FR-003)", () => {
    const groups = (messages as { ImportTemplates: { fieldGroups: Record<string, string> } })
      .ImportTemplates.fieldGroups;
    for (const k of ["text", "dateTime", "number", "structured"]) {
      expect(typeof groups[k]).toBe("string");
      expect(groups[k]).not.toBe("");
    }
  });

  it("ImportTemplates.validation covers every UI-rule message (none dead)", () => {
    const v = (messages as { ImportTemplates: { validation: Record<string, string> } })
      .ImportTemplates.validation;
    for (const k of [
      "duplicateKey",
      "conflictingMapping",
      "missingDateFormat",
      "atLeastOneMapping",
      "incompleteMapping",
    ]) {
      expect(typeof v[k]).toBe("string");
      expect(v[k]).not.toBe("");
    }
    // The duplicate-key message must match the server's frozen DUPLICATE_TEMPLATE message exactly.
    expect(v.duplicateKey).toBe("Já existe um modelo com esse nome e versão.");
  });

  it("ImportTemplates.confirmations + the Nav/Imports entry points resolve", () => {
    const m = messages as {
      ImportTemplates: { confirmations: Record<string, string> };
      Nav: Record<string, string>;
      // `Imports` holds nested objects (status, match), so its values are not all strings.
      Imports: Record<string, unknown>;
    };
    expect(m.ImportTemplates.confirmations.lastActiveTemplate).toBeTruthy();
    expect(m.Nav.importTemplates).toBeTruthy();
    expect(m.Imports.manageTemplates).toBeTruthy();
  });
});
