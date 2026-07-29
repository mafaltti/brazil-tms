import { type PgBoss } from "pg-boss";
import { eq, inArray } from "drizzle-orm";
import { db } from "@brazil-tms/db/client";
import {
  autoResolveAlert,
  billingItems,
  generateAlert,
  loadChecklistStatus,
  trips,
} from "@brazil-tms/db";
import { evaluateBillingReadiness } from "@brazil-tms/shared";
import { JOB, work } from "../../lib/queue";

/**
 * Feature 008 — the document-checks sweep (the SECOND scheduled worker job after 007's `sla.sweep`;
 * data-model §12, R11, COV-001). On the existing single worker + pg-boss queue, a ~5-min cron over the
 * billing-phase trips lights up the two §17 alert cases 007 deferred, via the 007 `alerts` store,
 * idempotently and independently:
 *   - case 7 `completed_missing_documents` = the trip has ≥1 unmet required document of ANY kind.
 *   - case 8 `billing_blocked_missing_proof` = `evaluateBillingReadiness` returns the
 *     `missing_billing_documents` blocker (blocked SPECIFICALLY by missing required-for-billing proof —
 *     NOT merely `no_pricing`/`open_billing_dispute`).
 * Per-trip fault isolation (skip-and-continue); each case generates/auto-resolves on its own predicate.
 */

/** Max trips reconciled per chunk. */
export const DOCUMENT_CHECKS_CHUNK_SIZE = 200;

/** The billing-phase statuses the sweep evaluates (R-D: a Billing Item exists / can be blocked). */
const BILLING_PHASE_SWEEP = ["billing_pending", "billing_ready"] as const;

export interface DocumentChecksSummary {
  durationMs: number;
  evaluated: number;
  alertsCreated: number;
  alertsResolved: number;
  errors: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface PerTripResult {
  alertsCreated: number;
  alertsResolved: number;
}

/** Reconcile the two §17 cases for one billing-phase trip in its own transaction. */
async function checkTrip(tripId: string): Promise<PerTripResult> {
  const tripRows = await db
    .select({
      id: trips.id,
      customerId: trips.customerId,
      laneId: trips.laneId,
      plannedVehicleType: trips.plannedVehicleType,
      currentStatus: trips.currentStatus,
    })
    .from(trips)
    .where(eq(trips.id, tripId))
    .limit(1);
  const trip = tripRows[0];
  if (!trip) return { alertsCreated: 0, alertsResolved: 0 };

  const checklist = await loadChecklistStatus(trip, db);
  // case 7: any required document (completion OR billing) still unmet.
  const anyMissing = checklist.completionMissing.length > 0 || checklist.billingMissing.length > 0;

  // case 8: blocked SPECIFICALLY by missing required-for-billing proof.
  const itemRows = await db
    .select({ base: billingItems.baseFreightCents, dispute: billingItems.disputeStatus })
    .from(billingItems)
    .where(eq(billingItems.tripId, tripId))
    .limit(1);
  const item = itemRows[0];
  const gate = evaluateBillingReadiness({
    currentStatus: trip.currentStatus,
    billingMissingDocuments: checklist.billingMissing.length,
    hasPricing: item?.base != null,
    disputeStatus: (item?.dispute ?? "none") as "none" | "open" | "resolved",
  });
  const blockedByMissingProof = gate.blockers.includes("missing_billing_documents");

  return db.transaction(async (tx) => {
    let alertsCreated = 0;
    let alertsResolved = 0;

    if (anyMissing) {
      if (await generateAlert(tx, tripId, "completed_missing_documents", "medium")) alertsCreated += 1;
    } else if (await autoResolveAlert(tx, tripId, "completed_missing_documents")) {
      alertsResolved += 1;
    }

    if (blockedByMissingProof) {
      if (await generateAlert(tx, tripId, "billing_blocked_missing_proof", "high")) alertsCreated += 1;
    } else if (await autoResolveAlert(tx, tripId, "billing_blocked_missing_proof")) {
      alertsResolved += 1;
    }

    return { alertsCreated, alertsResolved };
  });
}

/** Run one document-checks sweep over the billing-phase trips. Per-trip fault isolation + a summary. */
export async function runDocumentChecks(): Promise<DocumentChecksSummary> {
  const startedAt = Date.now();

  const rows = await db
    .select({ id: trips.id })
    .from(trips)
    .where(inArray(trips.currentStatus, [...BILLING_PHASE_SWEEP]));
  const ids = rows.map((r) => r.id);

  let evaluated = 0;
  let alertsCreated = 0;
  let alertsResolved = 0;
  let errors = 0;

  for (const batch of chunk(ids, DOCUMENT_CHECKS_CHUNK_SIZE)) {
    for (const tripId of batch) {
      try {
        const r = await checkTrip(tripId);
        evaluated += 1;
        alertsCreated += r.alertsCreated;
        alertsResolved += r.alertsResolved;
      } catch (err) {
        errors += 1;
        console.error("[document-checks] trip failed (skipped):", tripId, err);
      }
    }
  }

  const summary: DocumentChecksSummary = {
    durationMs: Date.now() - startedAt,
    evaluated,
    alertsCreated,
    alertsResolved,
    errors,
  };
  console.log(
    `[document-checks] done duration_ms=${summary.durationMs} evaluated=${summary.evaluated} ` +
      `alerts_created=${summary.alertsCreated} alerts_resolved=${summary.alertsResolved} errors=${summary.errors}`,
  );
  return summary;
}

/**
 * Register + schedule the sweep. The queue is created at bootstrap (`setupQueues` iterates `JOB`, which
 * now includes `documents.checks`). `boss.schedule` enqueues it on the cron (default every 5 min via
 * `DOCUMENT_CHECKS_CRON`) — the SECOND scheduled job in the codebase.
 */
export async function registerDocumentChecks(boss: PgBoss): Promise<void> {
  await work(boss, JOB.documentChecks, async () => {
    await runDocumentChecks();
  });
  const cron = process.env.DOCUMENT_CHECKS_CRON ?? "*/5 * * * *";
  await boss.schedule(JOB.documentChecks, cron, {}, {});
}
