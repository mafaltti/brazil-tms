import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, type DB } from "../client";
import { alerts, trips } from "../../schema";
import { Conflict } from "../errors";
import type { AlertDto } from "./trip-dto";

/**
 * Feature 007 — alert generation/auto-resolution helpers + the alert read (data-model §5, FR-023/024).
 * Generation is idempotent via the partial-unique `alerts_trip_case_open_uq` (ON CONFLICT DO NOTHING),
 * safe for the concurrent synchronous-BFF + worker-sweep paths (D3). Auto-resolution clears an
 * active/acknowledged row when its condition clears; a later recurrence inserts a fresh row.
 * Acknowledgement (US4) lives below `acknowledgeAlert`. Alerts are mutable → NO REVOKE; acknowledgement
 * is tracked on the row, NOT as an audit action (view triage, R13).
 */

/** Anything that can `insert`/`update` — the live `db` or a `tx`. */
type AlertExecutor = Pick<DB, "insert" | "update">;

export type AlertCase =
  | "unassigned_within_window"
  | "unconfirmed_within_window"
  | "missed_origin_arrival"
  | "missed_departure"
  | "missed_destination_arrival"
  | "high_severity_exception"
  | "completed_missing_documents"
  | "billing_blocked_missing_proof";

export type AlertSeverity = "low" | "medium" | "high";

/**
 * Idempotently raise an alert for `(tripId, alertCase)` while no active/acknowledged one exists. The
 * `ON CONFLICT (alerts_trip_case_open_uq) DO NOTHING` makes concurrent BFF + worker callers safe — at
 * most one not-yet-cleared row per (trip, case) (D3).
 */
export async function generateAlert(
  ex: AlertExecutor,
  tripId: string,
  alertCase: AlertCase,
  severity: AlertSeverity,
): Promise<boolean> {
  const inserted = await ex
    .insert(alerts)
    .values({ tripId, alertCase, severity, state: "active" })
    .onConflictDoNothing({
      target: [alerts.tripId, alerts.alertCase],
      // The arbiter is the partial-unique `alerts_trip_case_open_uq` — its predicate must match.
      where: sql`${alerts.state} IN ('active', 'acknowledged')`,
    })
    .returning({ id: alerts.id });
  return inserted.length > 0; // false ⇒ an active/acknowledged one already existed (idempotent no-op)
}

/**
 * Auto-resolve any active/acknowledged alert for `(tripId, alertCase)` when its condition clears. A
 * resolved row falls outside the partial-unique predicate, so a later recurrence can insert fresh.
 * Returns whether any row was actually resolved (for the sweep's summary counts).
 */
export async function autoResolveAlert(
  ex: AlertExecutor,
  tripId: string,
  alertCase: AlertCase,
): Promise<boolean> {
  const resolved = await ex
    .update(alerts)
    .set({ state: "resolved", autoResolvedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(alerts.tripId, tripId),
        eq(alerts.alertCase, alertCase),
        inArray(alerts.state, ["active", "acknowledged"]),
      ),
    )
    .returning({ id: alerts.id });
  return resolved.length > 0;
}

/**
 * Acknowledge an alert (US4): active|acknowledged → acknowledged, recording who/when. An already
 * `resolved` alert is stale (it auto-resolved) ⇒ `STALE_ALERT`. NOT an audit action (view triage).
 */
export async function acknowledgeAlert(alertId: string, actorUserId: string): Promise<AlertDto> {
  const now = new Date();
  const updated = await db
    .update(alerts)
    .set({ state: "acknowledged", acknowledgedByUserId: actorUserId, acknowledgedAt: now, updatedAt: now })
    .where(and(eq(alerts.id, alertId), inArray(alerts.state, ["active", "acknowledged"])))
    .returning();
  const row = updated[0];
  if (!row) {
    // Either the id does not exist or it is already resolved (auto-cleared).
    throw new Conflict("STALE_ALERT", "O alerta já foi resolvido.");
  }
  return {
    id: row.id,
    tripId: row.tripId,
    alertCase: row.alertCase,
    severity: row.severity,
    state: row.state,
    createdAt: row.createdAt.toISOString(),
    acknowledgedByUserId: row.acknowledgedByUserId,
    acknowledgedByName: null,
    acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
    autoResolvedAt: row.autoResolvedAt ? row.autoResolvedAt.toISOString() : null,
  };
}

export interface AlertListItem {
  id: string;
  tripId: string;
  externalTripId: string | null;
  customerName: string | null;
  alertCase: string;
  severity: string;
  state: string;
  createdAt: string;
  acknowledgedAt: string | null;
}

export interface AlertListResult {
  items: AlertListItem[];
  counts: {
    total: number;
    byCase: Record<string, number>;
    bySeverity: Record<string, number>;
  };
}

/**
 * List the not-yet-resolved (active/acknowledged) alerts, newest-first, with per-case/severity counts
 * for the board + dashboard surfaces (FR-023). Optional `state`/`tripId` narrow the list; resolved
 * rows are always excluded.
 */
export async function listAlerts(filters: { state?: string; tripId?: string } = {}): Promise<AlertListResult> {
  const conditions = [inArray(alerts.state, ["active", "acknowledged"])];
  if (filters.state === "active" || filters.state === "acknowledged") {
    conditions[0] = eq(alerts.state, filters.state);
  }
  if (filters.tripId) conditions.push(eq(alerts.tripId, filters.tripId));

  const rows = await db
    .select({
      id: alerts.id,
      tripId: alerts.tripId,
      externalTripId: trips.externalTripId,
      customerName: sql<string | null>`(select c.name from customers c where c.id = ${trips.customerId})`,
      alertCase: alerts.alertCase,
      severity: alerts.severity,
      state: alerts.state,
      createdAt: alerts.createdAt,
      acknowledgedAt: alerts.acknowledgedAt,
    })
    .from(alerts)
    .leftJoin(trips, eq(alerts.tripId, trips.id))
    .where(and(...conditions))
    .orderBy(desc(alerts.createdAt));

  const byCase: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const r of rows) {
    byCase[r.alertCase] = (byCase[r.alertCase] ?? 0) + 1;
    bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1;
  }

  return {
    items: rows.map((r) => ({
      id: r.id,
      tripId: r.tripId,
      externalTripId: r.externalTripId,
      customerName: r.customerName,
      alertCase: r.alertCase,
      severity: r.severity,
      state: r.state,
      createdAt: r.createdAt.toISOString(),
      acknowledgedAt: r.acknowledgedAt ? r.acknowledgedAt.toISOString() : null,
    })),
    counts: { total: rows.length, byCase, bySeverity },
  };
}
