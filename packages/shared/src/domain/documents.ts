/**
 * Feature 008 — pure, DB-free document-verification vocabulary + required-document checklist
 * evaluation (data-model §9.1, R1/R2/R10). The BFF/service gather the per-trip facts (the applicable
 * required types + the accepted-or-waived satisfied set); this module decides which required types are
 * still unmet for completion vs billing. The UI never decides (Constitution III). Mirrors 007's
 * `domain/sla-risk.ts`: an `as const` value set + a labeled-configurable default + a pure function.
 */

/** The fixed document-verification states the completion/billing gate branches on (mirrors a pgEnum). */
export const DOCUMENT_VERIFICATION_STATUSES = ["pending_review", "accepted", "rejected"] as const;

export type DocumentVerificationStatus = (typeof DOCUMENT_VERIFICATION_STATUSES)[number];

/**
 * Labeled-configurable fallback applied when a customer has NO `document_requirements` rows (§29
 * Input #3, FR-013). Scaffolding, NOT invented sign-off (Constitution II) — that customer's
 * document-checklist sign-off is reported blocked until the real per-customer list is supplied.
 * Keyed by document-type `code` (resolved to a type id by the service against `document_types`).
 */
export const DEFAULT_DOCUMENT_CHECKLIST = [
  { typeCode: "pod", requiredForCompletion: false, requiredForBilling: true },
] as const;

/** One applicable required document type for a trip (resolved from `document_requirements`). */
export interface RequiredType {
  documentTypeId: string;
  requiredForCompletion: boolean;
  requiredForBilling: boolean;
}

/**
 * Given the applicable required types and the set of document-type ids the trip already satisfies
 * (an accepted upload OR an audited waiver — R3), return which required type ids are still unmet for
 * completion vs for billing. A type may appear in both lists. Callers (`resolveRequiredTypes`) merge
 * duplicate type ids before calling, so the output preserves the deterministic input order.
 */
export function evaluateChecklist(
  required: RequiredType[],
  satisfiedTypeIds: ReadonlySet<string>,
): { completionMissing: string[]; billingMissing: string[] } {
  const completionMissing: string[] = [];
  const billingMissing: string[] = [];
  for (const r of required) {
    if (satisfiedTypeIds.has(r.documentTypeId)) continue;
    if (r.requiredForCompletion) completionMissing.push(r.documentTypeId);
    if (r.requiredForBilling) billingMissing.push(r.documentTypeId);
  }
  return { completionMissing, billingMissing };
}
