import { DateTime } from "luxon";
import { APP_LOCALE, APP_TIME_ZONE } from "../formatting";
import type { ExceptionSeverity, ReasonCodeCategory } from "./exceptions";

/**
 * Feature 009 — pure (DB-free) reporting helpers + the report read-model row TYPES (data-model §2–5).
 * The period helpers derive São-Paulo-anchored windows in Luxon so the three reports bucket trips on
 * business-day boundaries (R3); the read models in `@brazil-tms/db` compute the aggregates and return
 * these shapes. Monetary values are integer centavos (none in these reports); timestamps cross the BFF
 * as ISO strings. NO charting types — reports are tables + summary cards (R7).
 */

// ---------------------------------------------------------------------------
// Period derivation (R3) — São Paulo calendar windows as half-open UTC [from, to)
// ---------------------------------------------------------------------------

/** A resolved report period: a half-open UTC instant range `[from, to)` plus a pt-BR display label. */
export interface ReportPeriod {
  /** Inclusive lower bound, UTC ISO. */
  from: string;
  /** Exclusive upper bound, UTC ISO. */
  to: string;
  /** pt-BR label, e.g. "maio/2026" (default month) or "01/05/2026 – 31/05/2026" (custom range). */
  label: string;
}

function monthLabel(dt: DateTime): string {
  // "maio/2026" — month name + year in pt-BR.
  return dt.setLocale(APP_LOCALE).toFormat("LLLL/yyyy");
}

/**
 * The default report period: the last COMPLETED calendar month in `America/Sao_Paulo` (clarify Q3 /
 * R3). E.g. on any day in June 2026 → `[2026-05-01 00:00 BRT, 2026-06-01 00:00 BRT)`, label "maio/2026".
 */
export function defaultReportPeriod(now: Date): ReportPeriod {
  const thisMonthStart = DateTime.fromJSDate(now).setZone(APP_TIME_ZONE).startOf("month");
  const lastMonthStart = thisMonthStart.minus({ months: 1 });
  return {
    from: lastMonthStart.toUTC().toISO() ?? "",
    to: thisMonthStart.toUTC().toISO() ?? "",
    label: monthLabel(lastMonthStart),
  };
}

/**
 * A custom period from two São Paulo calendar-day strings (YYYY-MM-DD), `to` INCLUSIVE of its day —
 * `[from 00:00 BRT, to+1day 00:00 BRT)`. Mirrors the 005 board's `dayRangeSaoPaulo` pickup-filter
 * semantics so the report and the board agree on what "in range" means.
 */
export function customReportPeriod(from: string, to: string): ReportPeriod {
  const fromDt = DateTime.fromISO(from, { zone: APP_TIME_ZONE }).startOf("day");
  const toDt = DateTime.fromISO(to, { zone: APP_TIME_ZONE }).startOf("day");
  return {
    from: fromDt.toUTC().toISO() ?? "",
    to: toDt.plus({ days: 1 }).toUTC().toISO() ?? "",
    label: `${fromDt.toFormat("dd/MM/yyyy")} – ${toDt.toFormat("dd/MM/yyyy")}`,
  };
}

/** Resolve the effective period: a custom `from`+`to` range, else the default last calendar month. */
export function resolveReportPeriod(
  filters: { from?: string; to?: string },
  now: Date,
): ReportPeriod {
  if (filters.from && filters.to) return customReportPeriod(filters.from, filters.to);
  return defaultReportPeriod(now);
}

/**
 * The `YYYY-MM` São Paulo month keys whose calendar overlaps a period — the billing-readiness report
 * buckets by `billing_items.billing_period` (008's month-of-completion), so it filters on this list.
 * Always returns at least one month.
 */
export function billingPeriodMonths(period: ReportPeriod): string[] {
  const endExclusive = DateTime.fromISO(period.to).setZone(APP_TIME_ZONE);
  let cur = DateTime.fromISO(period.from).setZone(APP_TIME_ZONE).startOf("month");
  const months: string[] = [];
  while (cur < endExclusive) {
    months.push(cur.toFormat("yyyy-MM"));
    cur = cur.plus({ months: 1 });
  }
  return months.length > 0 ? months : [DateTime.fromISO(period.from).setZone(APP_TIME_ZONE).toFormat("yyyy-MM")];
}

// ---------------------------------------------------------------------------
// SLA performance report (SLA-005, REP-002, US1) — data-model §2
// ---------------------------------------------------------------------------

export interface SlaReportRow {
  /** customerId (groupBy=customer) or laneId (groupBy=lane). */
  groupKey: string;
  /** customer name, or the derived `ORIG → DEST` lane label. */
  groupLabel: string;
  total: number;
  /** via the shared onTimeExpr("pickup"); null when no actual pickup arrivals recorded. */
  onTimePickupPct: number | null;
  /** via the shared onTimeExpr("arrival"); null when no actual destination arrivals recorded. */
  onTimeArrivalPct: number | null;
  /**
   * Counts grouped from the STORED trips.sla_status (never re-derived, Constitution III). This is a
   * LIVE-risk snapshot: 007 clears sla_status when a trip leaves the active set, so closed trips fall
   * into `settled`. `onTrack + atRisk + late + breached + settled = total`. For a historical period
   * (mostly closed trips) the period performance is the on-time %s above; these states reflect the
   * still-open trips' current risk.
   */
  onTrack: number;
  atRisk: number;
  late: number;
  breached: number;
  /** trips with no stored sla_status (closed/settled — 007 cleared the live risk state). */
  settled: number;
}

/**
 * Overall (ungrouped) figures across the whole filtered set — the on-time %s are non-additive across
 * groups, so the summary cards read these exact aggregates rather than re-combining `groups`.
 */
export interface SlaReportTotals {
  total: number;
  onTimePickupPct: number | null;
  onTimeArrivalPct: number | null;
  onTrack: number;
  atRisk: number;
  late: number;
  breached: number;
  /** trips with no stored sla_status (closed/settled). onTrack+atRisk+late+breached+settled = total. */
  settled: number;
}

export interface SlaReport {
  period: ReportPeriod;
  /** true when an included customer lacks customer_sla_rules (computed on DEFAULT_SLA_POLICY, R8). */
  provisional: boolean;
  provisionalReason?: string;
  totals: SlaReportTotals;
  groups: SlaReportRow[];
}

// ---------------------------------------------------------------------------
// Exception analytics report (REP-003, US2) — data-model §3
// ---------------------------------------------------------------------------

export interface ExceptionReportGroupRow {
  groupKey: string;
  groupLabel: string;
  total: number;
  open: number;
  resolved: number;
}

export interface ExceptionReport {
  period: ReportPeriod;
  totals: {
    total: number;
    open: number;
    resolved: number;
    /** avg(resolved_at − opened_at) over resolved exceptions in the period; null when none resolved. */
    avgResolutionMinutes: number | null;
  };
  byCategory: { category: ReasonCodeCategory; count: number }[];
  bySeverity: { severity: ExceptionSeverity; count: number }[];
  groups: ExceptionReportGroupRow[];
}

// ---------------------------------------------------------------------------
// Billing readiness report (REP-004, US3) — data-model §4
// ---------------------------------------------------------------------------

export interface BillingPhaseCounts {
  billing_pending: number;
  billing_ready: number;
  billed: number;
  disputed: number;
}

export interface BillingReadinessGroupRow extends BillingPhaseCounts {
  groupKey: string;
  groupLabel: string;
}

export interface BillingReadinessReport {
  period: ReportPeriod;
  /** true when included customers rely on default document/billing rules (R8 — sign-off blocked). */
  provisional: boolean;
  provisionalReason?: string;
  phaseCounts: BillingPhaseCounts;
  completedMissingDocuments: number;
  /** share of completed trips whose completion→billing_ready gap ≤ 24h (clarify Q3); null when none. */
  pctReadyWithin24h: number | null;
  groups: BillingReadinessGroupRow[];
}

// ---------------------------------------------------------------------------
// Audit-view read (FR-013/014, US4) — data-model §5
// ---------------------------------------------------------------------------

export interface AuditLogView {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  previousValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  actorUserId: string;
  /** join users.name (NEW, 009); null if the actor row is missing. */
  actorName: string | null;
  reason: string | null;
  createdAt: string;
}

export interface AuditLogPage {
  items: AuditLogView[];
  total: number;
}

// ---------------------------------------------------------------------------
// Provisional/blocked reason strings (R8) — server-owned determination, pt-BR (UI is pt-BR only)
// ---------------------------------------------------------------------------

export const SLA_PROVISIONAL_REASON = "pendente de regras de SLA do cliente";
export const BILLING_PROVISIONAL_REASON = "pendente de regras de cobrança/documentos";
