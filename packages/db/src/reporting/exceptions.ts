import { and, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  resolveReportPeriod,
  type ExceptionReport,
  type ExceptionReportGroupRow,
  type ExceptionSeverity,
  type ReasonCodeCategory,
  type ReportFilter,
} from "@brazil-tms/shared";
import { db } from "../client";
import { customers, exceptions, locations, reasonCodes, trips } from "../../schema";

/**
 * Feature 009 — exception analytics read model (REP-003, US2; data-model §3, research R3). Read-only
 * projection over `exceptions` + `reason_codes` joined to `trips`→`customers`/`lanes`. Period
 * membership is by `exceptions.opened_at` (the occurrence date, R3). `open` = status ∈ {open,
 * monitoring}; `resolved` = status = resolved; `avgResolutionMinutes` = avg(resolved_at − opened_at)
 * over resolved exceptions. The delay-reason breakdown is volume grouped by `reason_codes.category`.
 * Reuses 007's `queryExceptions` join shape; no new table.
 */

const excOriginLoc = alias(locations, "rep_exc_origin_loc");
const excDestLoc = alias(locations, "rep_exc_dest_loc");

const OPEN = sql`${exceptions.status} IN ('open','monitoring')`;
const RESOLVED = sql`${exceptions.status} = 'resolved'`;

export async function queryExceptionReport(filters: ReportFilter): Promise<ExceptionReport> {
  const period = resolveReportPeriod(filters, new Date());
  const groupByLane = filters.groupBy === "lane";

  const conditions: SQL[] = [
    gte(exceptions.openedAt, new Date(period.from)),
    lt(exceptions.openedAt, new Date(period.to)),
  ];
  if (filters.customerId) conditions.push(eq(trips.customerId, filters.customerId));
  if (filters.laneId) conditions.push(eq(trips.laneId, filters.laneId));
  const where = and(...conditions);

  // The trip join backs the customer/lane filters + grouping (mirrors 007's queryExceptions joins).
  const [totalsRows, categoryRows, severityRows] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)::int`,
        open: sql<number>`count(*) FILTER (WHERE ${OPEN})::int`,
        resolved: sql<number>`count(*) FILTER (WHERE ${RESOLVED})::int`,
        avgResolutionMinutes: sql<number | null>`round(avg(
          extract(epoch from (${exceptions.resolvedAt} - ${exceptions.openedAt})) / 60.0
        ) FILTER (WHERE ${RESOLVED} AND ${exceptions.resolvedAt} IS NOT NULL))::int`,
      })
      .from(exceptions)
      .innerJoin(trips, eq(exceptions.tripId, trips.id))
      .where(where),
    db
      .select({ category: reasonCodes.category, count: sql<number>`count(*)::int` })
      .from(exceptions)
      .innerJoin(trips, eq(exceptions.tripId, trips.id))
      .innerJoin(reasonCodes, eq(exceptions.reasonCodeId, reasonCodes.id))
      .where(where)
      .groupBy(reasonCodes.category),
    db
      .select({ severity: exceptions.severity, count: sql<number>`count(*)::int` })
      .from(exceptions)
      .innerJoin(trips, eq(exceptions.tripId, trips.id))
      .where(where)
      .groupBy(exceptions.severity),
  ]);

  // Group rows (by customer default, or lane).
  let groups: ExceptionReportGroupRow[];
  const groupAgg = {
    total: sql<number>`count(*)::int`,
    open: sql<number>`count(*) FILTER (WHERE ${OPEN})::int`,
    resolved: sql<number>`count(*) FILTER (WHERE ${RESOLVED})::int`,
  };
  if (groupByLane) {
    const rows = await db
      .select({
        laneId: trips.laneId,
        originCode: excOriginLoc.code,
        destCode: excDestLoc.code,
        ...groupAgg,
      })
      .from(exceptions)
      .innerJoin(trips, eq(exceptions.tripId, trips.id))
      .leftJoin(excOriginLoc, eq(trips.originLocationId, excOriginLoc.id))
      .leftJoin(excDestLoc, eq(trips.destinationLocationId, excDestLoc.id))
      .where(where)
      .groupBy(trips.laneId, excOriginLoc.code, excDestLoc.code);
    groups = rows.map((r) => ({
      groupKey: r.laneId ?? "",
      groupLabel: r.laneId ? `${r.originCode ?? ""} → ${r.destCode ?? ""}` : "—",
      total: Number(r.total),
      open: Number(r.open),
      resolved: Number(r.resolved),
    }));
  } else {
    const rows = await db
      .select({ customerId: trips.customerId, customerName: customers.name, ...groupAgg })
      .from(exceptions)
      .innerJoin(trips, eq(exceptions.tripId, trips.id))
      .leftJoin(customers, eq(trips.customerId, customers.id))
      .where(where)
      .groupBy(trips.customerId, customers.name);
    groups = rows.map((r) => ({
      groupKey: r.customerId,
      groupLabel: r.customerName ?? "",
      total: Number(r.total),
      open: Number(r.open),
      resolved: Number(r.resolved),
    }));
  }
  groups.sort((a, b) => b.total - a.total || a.groupLabel.localeCompare(b.groupLabel, "pt-BR"));

  const t = totalsRows[0];
  const SEVERITY_ORDER: ExceptionSeverity[] = ["high", "medium", "low"];

  return {
    period,
    totals: {
      total: Number(t?.total ?? 0),
      open: Number(t?.open ?? 0),
      resolved: Number(t?.resolved ?? 0),
      avgResolutionMinutes: t?.avgResolutionMinutes == null ? null : Number(t.avgResolutionMinutes),
    },
    byCategory: categoryRows
      .map((r) => ({ category: r.category as ReasonCodeCategory, count: Number(r.count) }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
    bySeverity: severityRows
      .map((r) => ({ severity: r.severity as ExceptionSeverity, count: Number(r.count) }))
      .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)),
    groups,
  };
}
