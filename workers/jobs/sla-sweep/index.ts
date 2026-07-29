import { type PgBoss } from "pg-boss";
import { and, count, eq, inArray } from "drizzle-orm";
import { db } from "@brazil-tms/db/client";
import {
  autoResolveAlert,
  exceptions,
  generateAlert,
  recomputeTripSla,
  trips,
  type AlertCase,
  type AlertSeverity,
} from "@brazil-tms/db";
import { ACTIVE_TRIP_STATUSES } from "@brazil-tms/shared";
import { JOB, work } from "../../lib/queue";

/**
 * Feature 007 — the SLA sweep (the FIRST scheduled worker job; data-model §14, R10/R11). On the
 * existing single worker + pg-boss queue, a ~5-min cron recomputes server-authoritative SLA risk for
 * purely time-based triggers that no user action would otherwise flip, AND generates/auto-resolves the
 * in-app §17 alerts idempotently (US4). It is the time-based complement to the synchronous in-mutation
 * `recomputeTripSla` (milestones/exceptions/assignment) + the synchronous high-severity-exception
 * alert (US2).
 *
 * Safety/observability: only ACTIVE (non-terminal) trips; processed in chunks; EACH trip in its own
 * transaction under a `SELECT … FOR UPDATE` row lock (safe with the concurrent synchronous BFF recalc
 * — last-writer-wins on identical deterministic inputs) with per-trip try/catch fault isolation
 * (skip-and-continue, never abort the sweep); a structured per-sweep summary log.
 */

/** Max trips locked+recomputed per chunk (keeps each tx + lock window small). */
export const SLA_SWEEP_CHUNK_SIZE = 200;

export interface SlaSweepSummary {
  durationMs: number;
  evaluated: number;
  changed: number;
  alertsCreated: number;
  alertsResolved: number;
  errors: number;
}

/**
 * The 5 TIME-BASED §17 alert cases, keyed by the `sla_reasons` value that drives each. `delayed_loading`
 * has NO alert case (only these five time-based cases are in scope); `high_severity_exception` is
 * reconciled separately (the worker backstop). The 2 deferred cases (008/009) emit nothing.
 */
const REASON_TO_ALERT: Record<string, AlertCase> = {
  missing_assignment: "unassigned_within_window",
  missed_confirmation: "unconfirmed_within_window",
  delayed_origin_arrival: "missed_origin_arrival",
  delayed_departure: "missed_departure",
  delayed_destination_arrival: "missed_destination_arrival",
};

/** A window-miss (Late) reason raises a high-severity alert; the others (At Risk) raise medium. */
const ALERT_SEVERITY: Record<string, AlertSeverity> = {
  missed_origin_arrival: "high",
  missed_destination_arrival: "high",
  unassigned_within_window: "medium",
  unconfirmed_within_window: "medium",
  missed_departure: "medium",
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface PerTripResult {
  changed: boolean;
  alertsCreated: number;
  alertsResolved: number;
}

/**
 * Recompute one trip's SLA + reconcile its alerts under a row lock, in its own transaction. After the
 * recompute writes the fresh `sla_reasons`, each time-based alert case is generated when its reason is
 * present and auto-resolved when it clears (idempotent via the partial-unique). The
 * `high_severity_exception` alert is a BACKSTOP: re-created from the live open-high-sev count if the
 * synchronous US2 path ever missed it, and auto-resolved when the last high-sev exception closes.
 */
async function sweepTrip(tripId: string): Promise<PerTripResult> {
  return db.transaction(async (tx) => {
    const before = await tx
      .select({ s: trips.slaStatus })
      .from(trips)
      .where(eq(trips.id, tripId))
      .for("update")
      .limit(1);

    await recomputeTripSla(tx, tripId);

    const after = await tx
      .select({ s: trips.slaStatus, reasons: trips.slaReasons })
      .from(trips)
      .where(eq(trips.id, tripId))
      .limit(1);
    const changed = (before[0]?.s ?? null) !== (after[0]?.s ?? null);
    const reasons = new Set(after[0]?.reasons ?? []);

    let alertsCreated = 0;
    let alertsResolved = 0;

    // The 5 time-based cases: generate when the reason fired, auto-resolve when it cleared.
    for (const [reason, alertCase] of Object.entries(REASON_TO_ALERT)) {
      if (reasons.has(reason)) {
        if (await generateAlert(tx, tripId, alertCase, ALERT_SEVERITY[alertCase] ?? "medium")) {
          alertsCreated += 1;
        }
      } else if (await autoResolveAlert(tx, tripId, alertCase)) {
        alertsResolved += 1;
      }
    }

    // high_severity_exception backstop (R10/R11): reconcile from the live open/monitoring high-sev count.
    const hi = await tx
      .select({ value: count() })
      .from(exceptions)
      .where(
        and(
          eq(exceptions.tripId, tripId),
          inArray(exceptions.status, ["open", "monitoring"]),
          eq(exceptions.severity, "high"),
        ),
      );
    if ((hi[0]?.value ?? 0) > 0) {
      if (await generateAlert(tx, tripId, "high_severity_exception", "high")) alertsCreated += 1;
    } else if (await autoResolveAlert(tx, tripId, "high_severity_exception")) {
      alertsResolved += 1;
    }

    return { changed, alertsCreated, alertsResolved };
  });
}

/**
 * Run one SLA sweep over all active trips. Per-trip fault isolation: a bad trip is logged and skipped,
 * the sweep continues. Emits + returns a structured summary. Scheduled cron has no per-run input, so
 * the job takes no payload.
 */
export async function runSlaSweep(): Promise<SlaSweepSummary> {
  const startedAt = Date.now();

  const activeRows = await db
    .select({ id: trips.id })
    .from(trips)
    .where(inArray(trips.currentStatus, [...ACTIVE_TRIP_STATUSES]));
  const ids = activeRows.map((r) => r.id);

  let evaluated = 0;
  let changed = 0;
  let alertsCreated = 0;
  let alertsResolved = 0;
  let errors = 0;

  for (const batch of chunk(ids, SLA_SWEEP_CHUNK_SIZE)) {
    for (const tripId of batch) {
      try {
        const r = await sweepTrip(tripId);
        evaluated += 1;
        if (r.changed) changed += 1;
        alertsCreated += r.alertsCreated;
        alertsResolved += r.alertsResolved;
      } catch (err) {
        errors += 1;
        console.error("[sla-sweep] trip failed (skipped):", tripId, err);
      }
    }
  }

  const summary: SlaSweepSummary = {
    durationMs: Date.now() - startedAt,
    evaluated,
    changed,
    alertsCreated,
    alertsResolved,
    errors,
  };
  console.log(
    `[sla-sweep] done duration_ms=${summary.durationMs} evaluated=${summary.evaluated} ` +
      `changed=${summary.changed} alerts_created=${summary.alertsCreated} ` +
      `alerts_resolved=${summary.alertsResolved} errors=${summary.errors}`,
  );
  return summary;
}

/**
 * Register + schedule the sweep on the worker's pg-boss instance. The queue is created at bootstrap
 * (`setupQueues` iterates the merged `JOB` map, which now includes `sla.sweep`). `work` consumes the
 * job; `boss.schedule` enqueues it on the cron (default every 5 min, overridable via `SLA_SWEEP_CRON`).
 * This is the first-ever `boss.schedule` usage in the codebase.
 */
export async function registerSlaSweep(boss: PgBoss): Promise<void> {
  await work(boss, JOB.slaSweep, async () => {
    await runSlaSweep();
  });
  const cron = process.env.SLA_SWEEP_CRON ?? "*/5 * * * *";
  await boss.schedule(JOB.slaSweep, cron, {}, {});
}
