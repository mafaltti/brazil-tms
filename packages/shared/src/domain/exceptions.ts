/**
 * Feature 007 — the pure exception-lifecycle vocabulary + transition map (data-model §9.2, FR-009..
 * FR-012). Mirrors `domain/trip-status.ts`: `as const` value sets + a `Record<…, readonly …[]>` map +
 * a pure predicate. The DB pgEnums (`exception_status`/`exception_severity`/
 * `exception_responsible_party`) and the `reason_codes.category` CHECK are kept in lockstep with these
 * arrays (PR review enforces it, like 003).
 */

// ---------------------------------------------------------------------------
// Value sets
// ---------------------------------------------------------------------------

export const EXCEPTION_STATUSES = ["open", "monitoring", "resolved", "cancelled"] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];

/** `high` is the SLA/alert trigger (FR-012). */
export const EXCEPTION_SEVERITIES = ["low", "medium", "high"] as const;
export type ExceptionSeverity = (typeof EXCEPTION_SEVERITIES)[number];

/**
 * The 5-value responsible-party set — adds `force_majeure` vs 003's 4-value
 * `CANCELLATION_RESPONSIBLE_PARTIES` (FR-011). It is its OWN set, never reusing that one.
 */
export const EXCEPTION_RESPONSIBLE_PARTIES = [
  "customer_caused",
  "brazil_transports_caused",
  "carrier_caused",
  "force_majeure",
  "unknown",
] as const;
export type ExceptionResponsibleParty = (typeof EXCEPTION_RESPONSIBLE_PARTIES)[number];

/** The 12 EXC-004 categories — mirrors the `reason_codes.category` CHECK, kept in lockstep. */
export const REASON_CODE_CATEGORIES = [
  "delay",
  "no_show",
  "breakdown",
  "driver_issue",
  "customer_delay",
  "loading_delay",
  "unloading_delay",
  "documentation",
  "accident",
  "route_deviation",
  "cancellation",
  "other",
] as const;
export type ReasonCodeCategory = (typeof REASON_CODE_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// Lifecycle (FR-009: Open↔Monitoring; →Resolved/Cancelled terminal — no reopen)
// ---------------------------------------------------------------------------

/** The legal exception transition map. Resolved/Cancelled are terminal; a recurrence is a new row. */
export const EXCEPTION_TRANSITIONS: Record<ExceptionStatus, readonly ExceptionStatus[]> = {
  open: ["monitoring", "resolved", "cancelled"],
  monitoring: ["open", "resolved", "cancelled"],
  resolved: [], // terminal — no reopen
  cancelled: [], // terminal — no reopen
};

/** Is `from → to` a declared legal exception transition? */
export function canTransitionException(from: ExceptionStatus, to: ExceptionStatus): boolean {
  return EXCEPTION_TRANSITIONS[from]?.includes(to) ?? false;
}
