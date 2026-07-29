import { isActiveStatus, TRIP_STATUSES, type TripStatus } from "./trip-status";

/**
 * Feature 007 — the pure, DB-free SLA-risk evaluator (data-model §9.1, FR-014..FR-019). This is the
 * SINGLE SLA authority the BFF (`recomputeTripSla`) and the worker sweep both call; the UI NEVER
 * computes risk (Constitution III; STACK §3.13 names it a Vitest focus). It mirrors 006's
 * `assignment-eligibility.ts`: an `as const` value set + a context object + a pure function +
 * a labeled-configurable default policy.
 *
 * Locked decisions encoded verbatim:
 *  - D1 trigger→state map: a missed planned origin/destination arrival window ⇒ Late; missing
 *    assignment / missed confirmation / delayed loading / delayed departure / open high-severity
 *    exception ⇒ At Risk; none ⇒ On Track. **Breached is unreachable in MVP** (needs a customer
 *    threshold, §29 Input #2) — the value exists but no trigger maps to it.
 *  - D2 worst-state-wins: `status` = the most severe (by `SLA_STATUSES` ordinal) of all fired
 *    reasons' states; `reasons` retains ALL fired triggers (canonical `SLA_REASONS` order).
 */

// ---------------------------------------------------------------------------
// Value sets (ordinal = severity)
// ---------------------------------------------------------------------------

/** SLA-risk states, ascending severity (the array index IS the severity ordinal, D2). */
export const SLA_STATUSES = ["on_track", "at_risk", "late", "breached"] as const;

export type SlaStatus = (typeof SLA_STATUSES)[number];

/** The seven contributing triggers (data-model §9.1). */
export const SLA_REASONS = [
  "missing_assignment",
  "missed_confirmation",
  "delayed_origin_arrival",
  "delayed_loading",
  "delayed_departure",
  "delayed_destination_arrival",
  "open_high_severity_exception",
] as const;

export type SlaReason = (typeof SLA_REASONS)[number];

/** D1 — each reason's contributed state. Window-miss ⇒ Late; everything else ⇒ At Risk. */
const REASON_STATE: Record<SlaReason, SlaStatus> = {
  missing_assignment: "at_risk",
  missed_confirmation: "at_risk",
  delayed_origin_arrival: "late",
  delayed_loading: "at_risk",
  delayed_departure: "at_risk",
  delayed_destination_arrival: "late",
  open_high_severity_exception: "at_risk",
};

// ---------------------------------------------------------------------------
// Context + policy
// ---------------------------------------------------------------------------

/** All the per-trip facts the evaluator needs — gathered DB-side, then evaluated purely. */
export interface SlaContext {
  now: Date;
  currentStatus: TripStatus;
  plannedPickupWindowStart: Date | null;
  plannedPickupWindowEnd: Date | null;
  plannedDeliveryWindowStart: Date | null;
  plannedDeliveryWindowEnd: Date | null;
  /** From the 006 current assignment row (read-only). */
  confirmedAt: Date | null;
  /** A current `trip_assignments` row exists (006, read-only). */
  assignmentPresent: boolean;
  /** exceptions WHERE status IN ('open','monitoring') AND severity='high'. */
  openHighSeverityExceptionCount: number;
  /** Latest `status_change` event ts for the current status (time-in-status leg). */
  currentStatusEnteredAt: Date | null;
}

/**
 * The labeled-configurable default magnitudes; a `customer_sla_rules` row overrides them (US5).
 * Minutes (integer) for unambiguous UTC arithmetic.
 */
export interface SlaPolicy {
  atRiskWarningMinutes: number; // 60 — warning window before a deadline
  pickupToleranceMinutes: number; // 0  — window edge is the cutoff
  deliveryToleranceMinutes: number; // 0
  confirmationCutoffMinutes: number; // 120 — required assignment/confirmation lead time before pickup
  timeInStatusThresholdMinutes: number; // 120 — loading/departure stuck threshold
}

/** Company defaults (§29 Input #2 — a customer with no rule runs on these; SLA sign-off blocked). */
export const DEFAULT_SLA_POLICY: SlaPolicy = {
  atRiskWarningMinutes: 60,
  pickupToleranceMinutes: 0,
  deliveryToleranceMinutes: 0,
  confirmationCutoffMinutes: 120,
  timeInStatusThresholdMinutes: 120,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_INDEX = (s: TripStatus): number => TRIP_STATUSES.indexOf(s);
const AT_ORIGIN_INDEX = STATUS_INDEX("at_origin");
const AT_DESTINATION_INDEX = STATUS_INDEX("at_destination");

const plusMinutes = (d: Date, minutes: number): Date => new Date(d.getTime() + minutes * 60_000);
const minusMinutes = (d: Date, minutes: number): Date => new Date(d.getTime() - minutes * 60_000);

// ---------------------------------------------------------------------------
// The evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate a trip's SLA-risk state + all contributing reasons (D1/D2). Terminal/cancelled trips
 * short-circuit to On Track with no reasons (the caller skips the write). Each leg null-guards its
 * own required inputs, so a missing planned window simply skips that window-based leg (FR-016).
 */
export function evaluateSlaRisk(
  ctx: SlaContext,
  policy: SlaPolicy = DEFAULT_SLA_POLICY,
): { status: SlaStatus; reasons: SlaReason[] } {
  // Terminal/cancelled trips are not evaluated (Edge Case).
  if (!isActiveStatus(ctx.currentStatus)) {
    return { status: "on_track", reasons: [] };
  }

  const fired = new Set<SlaReason>();
  const idx = STATUS_INDEX(ctx.currentStatus);
  const beforeOrigin = idx < AT_ORIGIN_INDEX;
  const beforeDestination = idx < AT_DESTINATION_INDEX;

  // Lead-time deadline by which a trip must be assigned + confirmed (needs the pickup window).
  const confirmationDeadline =
    ctx.plannedPickupWindowStart != null
      ? minusMinutes(ctx.plannedPickupWindowStart, policy.confirmationCutoffMinutes)
      : null;

  // missing_assignment (At Risk) — no current assignment past the lead-time point (FR-017).
  if (!ctx.assignmentPresent && confirmationDeadline != null && ctx.now >= confirmationDeadline) {
    fired.add("missing_assignment");
  }

  // missed_confirmation (At Risk) — assigned but not confirmed by the lead-time point (FR-017).
  if (
    ctx.assignmentPresent &&
    ctx.confirmedAt == null &&
    confirmationDeadline != null &&
    ctx.now >= confirmationDeadline
  ) {
    fired.add("missed_confirmation");
  }

  // delayed_origin_arrival (Late) — not yet at origin past the pickup window + tolerance (FR-015).
  if (
    beforeOrigin &&
    ctx.plannedPickupWindowEnd != null &&
    ctx.now > plusMinutes(ctx.plannedPickupWindowEnd, policy.pickupToleranceMinutes)
  ) {
    fired.add("delayed_origin_arrival");
  }

  // delayed_loading (At Risk) — stuck in `loading` beyond the time-in-status threshold (FR-018).
  if (
    ctx.currentStatus === "loading" &&
    ctx.currentStatusEnteredAt != null &&
    ctx.now > plusMinutes(ctx.currentStatusEnteredAt, policy.timeInStatusThresholdMinutes)
  ) {
    fired.add("delayed_loading");
  }

  // delayed_departure (At Risk) — `loaded` but not departed beyond the threshold (FR-018).
  if (
    ctx.currentStatus === "loaded" &&
    ctx.currentStatusEnteredAt != null &&
    ctx.now > plusMinutes(ctx.currentStatusEnteredAt, policy.timeInStatusThresholdMinutes)
  ) {
    fired.add("delayed_departure");
  }

  // delayed_destination_arrival (Late) — not yet at destination past delivery window + tol (FR-015).
  if (
    beforeDestination &&
    ctx.plannedDeliveryWindowEnd != null &&
    ctx.now > plusMinutes(ctx.plannedDeliveryWindowEnd, policy.deliveryToleranceMinutes)
  ) {
    fired.add("delayed_destination_arrival");
  }

  // open_high_severity_exception (At Risk) — any open/monitoring high-severity exception (FR-012).
  if (ctx.openHighSeverityExceptionCount > 0) {
    fired.add("open_high_severity_exception");
  }

  // Preserve canonical SLA_REASONS order for deterministic output.
  const reasons = SLA_REASONS.filter((r) => fired.has(r));

  // D2 — worst-state-wins over all fired reasons (ordinal in SLA_STATUSES).
  let status: SlaStatus = "on_track";
  for (const r of reasons) {
    const s = REASON_STATE[r];
    if (SLA_STATUSES.indexOf(s) > SLA_STATUSES.indexOf(status)) status = s;
  }

  return { status, reasons };
}
