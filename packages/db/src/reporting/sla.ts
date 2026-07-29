import { and, eq, gte, inArray, lt, ne, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  resolveReportPeriod,
  SLA_PROVISIONAL_REASON,
  type ReportFilter,
  type SlaReport,
  type SlaReportRow,
  type SlaReportTotals,
} from "@brazil-tms/shared";
import { db } from "../client";
import { customers, customerSlaRules, locations, trips } from "../../schema";
import { onTimeExpr } from "../trips/on-time";

/**
 * Feature 009 — SLA performance read model (SLA-005, REP-002, US1; data-model §2, research R2/R3/R8).
 *
 * Read-only projection over `trips` (+ `trip_events` via the shared `onTimeExpr`) for one customer/
 * lane/period. On-time pickup/arrival % come from `onTimeExpr` (the SAME predicate the dashboard uses
 * — never re-derived, clarify Q4); the SLA-state counts come from the STORED `trips.sla_status`
 * (`on_track`/`at_risk`/`late`/`breached`, owned by 007 — never re-classified here, Constitution III).
 * Period membership is by `planned_pickup_window_start` (the operational date, R3); cancelled trips are
 * excluded. `provisional` is true when any included customer has no active `customer_sla_rules` (the
 * report runs on `DEFAULT_SLA_POLICY` → SLA sign-off blocked, R8) — surfaced, never invented.
 */

const slaOriginLoc = alias(locations, "sla_origin_loc");
const slaDestLoc = alias(locations, "sla_dest_loc");

/** count(*) FILTER aggregates shared by both groupings (cast ::int → JS number). */
function aggregates() {
  const pickup = onTimeExpr("pickup");
  const arrival = onTimeExpr("arrival");
  return {
    total: sql<number>`count(*)::int`,
    pickupDenom: sql<number>`count(*) FILTER (WHERE ${pickup.actualRecorded})::int`,
    pickupNum: sql<number>`count(*) FILTER (WHERE ${pickup.onTime})::int`,
    arrivalDenom: sql<number>`count(*) FILTER (WHERE ${arrival.actualRecorded})::int`,
    arrivalNum: sql<number>`count(*) FILTER (WHERE ${arrival.onTime})::int`,
    onTrack: sql<number>`count(*) FILTER (WHERE ${trips.slaStatus} = 'on_track')::int`,
    atRisk: sql<number>`count(*) FILTER (WHERE ${trips.slaStatus} = 'at_risk')::int`,
    late: sql<number>`count(*) FILTER (WHERE ${trips.slaStatus} = 'late')::int`,
    breached: sql<number>`count(*) FILTER (WHERE ${trips.slaStatus} = 'breached')::int`,
    // closed/settled trips: 007 clears sla_status when a trip leaves the active set (sla.ts).
    settled: sql<number>`count(*) FILTER (WHERE ${trips.slaStatus} IS NULL)::int`,
  };
}

interface AggRow {
  total: number;
  pickupDenom: number;
  pickupNum: number;
  arrivalDenom: number;
  arrivalNum: number;
  onTrack: number;
  atRisk: number;
  late: number;
  breached: number;
  settled: number;
}

const pct = (num: number, denom: number): number | null =>
  denom > 0 ? Math.round((Number(num) / Number(denom)) * 100) : null;

function toRow(a: AggRow, groupKey: string, groupLabel: string): SlaReportRow {
  return {
    groupKey,
    groupLabel,
    total: Number(a.total),
    onTimePickupPct: pct(a.pickupNum, a.pickupDenom),
    onTimeArrivalPct: pct(a.arrivalNum, a.arrivalDenom),
    onTrack: Number(a.onTrack),
    atRisk: Number(a.atRisk),
    late: Number(a.late),
    breached: Number(a.breached),
    settled: Number(a.settled),
  };
}

export async function querySlaReport(filters: ReportFilter): Promise<SlaReport> {
  const period = resolveReportPeriod(filters, new Date());
  const groupByLane = filters.groupBy === "lane";

  const conditions: SQL[] = [
    gte(trips.plannedPickupWindowStart, new Date(period.from)),
    lt(trips.plannedPickupWindowStart, new Date(period.to)),
    ne(trips.currentStatus, "cancelled"),
  ];
  if (filters.customerId) conditions.push(eq(trips.customerId, filters.customerId));
  if (filters.laneId) conditions.push(eq(trips.laneId, filters.laneId));
  const where = and(...conditions);

  const agg = aggregates();

  let groups: SlaReportRow[];
  if (groupByLane) {
    const rows = await db
      .select({
        laneId: trips.laneId,
        originCode: slaOriginLoc.code,
        destCode: slaDestLoc.code,
        ...agg,
      })
      .from(trips)
      .leftJoin(slaOriginLoc, eq(trips.originLocationId, slaOriginLoc.id))
      .leftJoin(slaDestLoc, eq(trips.destinationLocationId, slaDestLoc.id))
      .where(where)
      .groupBy(trips.laneId, slaOriginLoc.code, slaDestLoc.code);
    groups = rows.map((r) =>
      toRow(
        r,
        r.laneId ?? "",
        r.laneId ? `${r.originCode ?? ""} → ${r.destCode ?? ""}` : "—",
      ),
    );
  } else {
    const rows = await db
      .select({ customerId: trips.customerId, customerName: customers.name, ...agg })
      .from(trips)
      .leftJoin(customers, eq(trips.customerId, customers.id))
      .where(where)
      .groupBy(trips.customerId, customers.name);
    groups = rows.map((r) => toRow(r, r.customerId, r.customerName ?? ""));
  }

  groups.sort((a, b) => a.groupLabel.localeCompare(b.groupLabel, "pt-BR"));

  // Overall (ungrouped) aggregate for the summary cards — exact on-time %s across the whole set.
  const overallRows = await db.select(agg).from(trips).where(where);
  const o = overallRows[0];
  const totals: SlaReportTotals = {
    total: Number(o?.total ?? 0),
    onTimePickupPct: pct(Number(o?.pickupNum ?? 0), Number(o?.pickupDenom ?? 0)),
    onTimeArrivalPct: pct(Number(o?.arrivalNum ?? 0), Number(o?.arrivalDenom ?? 0)),
    onTrack: Number(o?.onTrack ?? 0),
    atRisk: Number(o?.atRisk ?? 0),
    late: Number(o?.late ?? 0),
    breached: Number(o?.breached ?? 0),
    settled: Number(o?.settled ?? 0),
  };

  // provisional: any included customer lacking an active customer_sla_rules row runs on the default
  // policy (R8) → SLA-reporting sign-off blocked. Compute over the same filtered trip set.
  const customerRows = await db
    .selectDistinct({ customerId: trips.customerId })
    .from(trips)
    .where(where);
  const includedCustomerIds = customerRows.map((r) => r.customerId);
  let provisional = false;
  if (includedCustomerIds.length > 0) {
    const ruled = await db
      .selectDistinct({ customerId: customerSlaRules.customerId })
      .from(customerSlaRules)
      .where(
        and(
          inArray(customerSlaRules.customerId, includedCustomerIds),
          eq(customerSlaRules.active, true),
        ),
      );
    const ruledSet = new Set(ruled.map((r) => r.customerId));
    provisional = includedCustomerIds.some((id) => !ruledSet.has(id));
  }

  return {
    period,
    provisional,
    ...(provisional ? { provisionalReason: SLA_PROVISIONAL_REASON } : {}),
    totals,
    groups,
  };
}
