import { sql, type SQL } from "drizzle-orm";
import { trips } from "../../schema";

/**
 * Feature 009 — the SHARED on-time pickup/arrival predicate (data-model §1, research R2, clarify Q4).
 *
 * DRY-for-correctness: the on-time computation was inlined in `queryDashboardMetrics` (005/007). The
 * SLA report (`querySlaReport`) must present the SAME on-time numbers as the daily dashboard, so the
 * predicate is extracted ONCE here and consumed by both — the two surfaces can never diverge. This is
 * NOT a speculative abstraction; it consolidates one existing computation into its single source.
 *
 * It mirrors 007's definition exactly:
 *   pickup  — actual recorded = a `trip_events` row with `status_after = 'at_origin'`;
 *             on-time = that event's timestamp ≤ `trips.planned_pickup_window_end`.
 *   arrival — actual recorded = a `trip_events` row with `status_after = 'at_destination'`;
 *             on-time = that event's timestamp ≤ `trips.planned_delivery_window_end`.
 * Event timestamp = `event_timestamp` falling back to `created_at` (the existing dashboard rule).
 * On-time % = count(onTime) / count(actualRecorded) × 100 (NULL when the denominator is 0).
 *
 * Returned as correlated boolean SQL fragments over the current `trips` row, so a caller can
 * `count(*) FILTER (WHERE …)` per any grouping (the dashboard groups company-wide/30-day; the SLA
 * report groups by customer/lane within the selected period). Reads only existing columns — no DDL.
 */

export type OnTimeKind = "pickup" | "arrival";

export interface OnTimeExpr {
  /** The relevant actual arrival event was recorded for the trip (the on-time % denominator). */
  actualRecorded: SQL<boolean>;
  /** The recorded arrival was within the planned window (implies `actualRecorded`; the numerator). */
  onTime: SQL<boolean>;
}

export function onTimeExpr(kind: OnTimeKind): OnTimeExpr {
  const statusAfter = kind === "pickup" ? "at_origin" : "at_destination";
  const windowEnd =
    kind === "pickup" ? trips.plannedPickupWindowEnd : trips.plannedDeliveryWindowEnd;
  // Earliest recorded arrival instant for this milestone (event_timestamp ?? created_at).
  const arrivedAt = sql`(
    SELECT min(coalesce(e.event_timestamp, e.created_at))
    FROM trip_events e
    WHERE e.trip_id = ${trips.id} AND e.status_after = ${statusAfter}
  )`;
  return {
    actualRecorded: sql<boolean>`${arrivedAt} IS NOT NULL`,
    onTime: sql<boolean>`${arrivedAt} IS NOT NULL AND ${arrivedAt} <= ${windowEnd}`,
  };
}
