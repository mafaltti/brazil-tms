import { type TripStatus } from "./trip-status";

/**
 * Feature 008 — pure, DB-free billing vocabulary + the billable-value computation + the two
 * server-authoritative gate evaluators (data-model §9.2, R6/R7/R10). The BFF/service gather context;
 * the UI never decides completion/billing-readiness (Constitution III; STACK §3.13 names
 * billing-readiness a Vitest focus). Mirrors 007's `domain/sla-risk.ts`.
 */

// ---------------------------------------------------------------------------
// Value sets
// ---------------------------------------------------------------------------

/** The seven addable billing-adjustment types (BILL-004). `computeBillingValues` branches on these. */
export const BILLING_ADJUSTMENT_TYPES = [
  "toll",
  "waiting_time",
  "redelivery",
  "extra_stop",
  "penalty",
  "discount",
  "manual_adjustment",
] as const;

export type BillingAdjustmentType = (typeof BILLING_ADJUSTMENT_TYPES)[number];

/** Export file formats (CHECK text on `export_batches.format`; a 2-value display set, no logic branch). */
export const EXPORT_FORMATS = ["csv", "xlsx"] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Durable export-batch status (mirrors the existing `import_batch_status` pgEnum). */
export const EXPORT_BATCH_STATUSES = ["queued", "running", "completed", "failed"] as const;

export type ExportBatchStatus = (typeof EXPORT_BATCH_STATUSES)[number];

// ---------------------------------------------------------------------------
// Billable-value computation (BILL-005, FR-017) — derived, never stored (R5/R6)
// ---------------------------------------------------------------------------

export interface AdjustmentInput {
  type: BillingAdjustmentType;
  amountCents: number;
}

/**
 * Compute the transparent billable breakdown from the base freight + the live typed adjustments.
 *  - `executed` = the base freight (rate-derived or manual; FR-017).
 *  - `planned` = the rate base (in MVP the same base-freight term; null when unpriced).
 *  - `adjustment` = Σ adjustments, where `discount` amounts are SUBTRACTED, every other type ADDED,
 *    and `manual_adjustment` is taken with its own sign (BILL-005).
 *  - `final billable` = executed + adjustment (null when there is no base freight yet).
 * Integer centavos throughout (BRL).
 */
export function computeBillingValues(
  baseFreightCents: number | null,
  adjustments: AdjustmentInput[],
): {
  plannedCents: number | null;
  executedCents: number | null;
  adjustmentCents: number;
  finalBillableCents: number | null;
} {
  let adjustmentCents = 0;
  for (const a of adjustments) {
    adjustmentCents += a.type === "discount" ? -a.amountCents : a.amountCents;
  }
  const executedCents = baseFreightCents;
  return {
    plannedCents: baseFreightCents,
    executedCents,
    adjustmentCents,
    finalBillableCents: executedCents === null ? null : executedCents + adjustmentCents,
  };
}

// ---------------------------------------------------------------------------
// The two pure gate evaluators (§19.3 / §19.4, FR-007/009/013)
// ---------------------------------------------------------------------------

export type CompletionBlocker = "not_unloaded" | "missing_completion_documents" | "cancelled";

export type BillingBlocker =
  | "not_billing_pending"
  | "missing_billing_documents"
  | "no_pricing"
  | "open_billing_dispute";

/**
 * §19.3 — a trip may be marked Completed only from `unloaded`, when it is not cancelled and every
 * required-for-completion document is satisfied (accepted-or-waived). Always REPORTS blockers (never
 * silently passes); block-vs-warn is applied by the caller (default block, clarify).
 */
export function evaluateCompletionReadiness(ctx: {
  currentStatus: TripStatus;
  completionMissingDocuments: number;
}): { canComplete: boolean; blockers: CompletionBlocker[] } {
  const blockers: CompletionBlocker[] = [];
  if (ctx.currentStatus === "cancelled") {
    blockers.push("cancelled");
  } else if (ctx.currentStatus !== "unloaded") {
    blockers.push("not_unloaded");
  }
  if (ctx.completionMissingDocuments > 0) blockers.push("missing_completion_documents");
  return { canComplete: blockers.length === 0, blockers };
}

/**
 * §19.4 — a trip may be marked Billing Ready only from `billing_pending`, when every
 * required-for-billing document is satisfied, it has pricing (a rate-derived or manual base freight),
 * and there is no open billing dispute.
 */
export function evaluateBillingReadiness(ctx: {
  currentStatus: TripStatus;
  billingMissingDocuments: number;
  hasPricing: boolean;
  disputeStatus: "none" | "open" | "resolved";
}): { canBillReady: boolean; blockers: BillingBlocker[] } {
  const blockers: BillingBlocker[] = [];
  if (ctx.currentStatus !== "billing_pending") blockers.push("not_billing_pending");
  if (ctx.billingMissingDocuments > 0) blockers.push("missing_billing_documents");
  if (!ctx.hasPricing) blockers.push("no_pricing");
  if (ctx.disputeStatus === "open") blockers.push("open_billing_dispute");
  return { canBillReady: blockers.length === 0, blockers };
}
