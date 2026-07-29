import { eq } from "drizzle-orm";
import { db, type DB } from "../client";
import { billingItems, documents, trips } from "../../schema";
import {
  evaluateBillingReadiness,
  evaluateChecklist,
  evaluateCompletionReadiness,
  type MarkBillingReadyInput,
  type MarkCompletedInput,
} from "@brazil-tms/shared";
import { writeAudit } from "../audit/write-audit";
import { Conflict } from "../errors";
import { transitionTripStatus } from "./trip-transitions";
import { loadTripDetail, type TripDetail } from "./trip-dto";
import { ensureBillingItem } from "../billing/billing-items";
import { resolveRequiredTypes, satisfiedDocumentTypeIds, type TripScope } from "../documents/requirements";

/**
 * Feature 008 — completion + Billing-Ready transitions (data-model §11, R7). These are transitions on
 * the EXISTING 003 status machine: each gathers context, calls the PURE `evaluateCompletionReadiness`/
 * `evaluateBillingReadiness` (the UI never decides — Constitution III), records any per-document
 * waivers, and drives the change through the REUSED `transitionTripStatus` (its concurrency guard +
 * `trip_events` + `trip.status_change` audit). A refused gate writes NO state. Completion auto-advances
 * to `billing_pending` (§11.6) and creates the billing item.
 */

type TxLike = Pick<DB, "insert">;

interface TripScopeWithStatus extends TripScope {
  currentStatus: TripDetail["currentStatus"];
}

async function loadTripScope(tripId: string): Promise<TripScopeWithStatus | null> {
  const rows = await db
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
  return rows[0] ?? null;
}

/** Record each per-document waiver (no file, `waived_at` set) + a `document.waive` audit. Skips a type
 * that is already satisfied (so a retry never duplicates a waiver). */
async function recordWaivers(
  tx: TxLike,
  tripId: string,
  waivers: { documentTypeId: string; reason: string }[],
  alreadySatisfied: ReadonlySet<string>,
  actorUserId: string,
): Promise<void> {
  for (const w of waivers) {
    if (alreadySatisfied.has(w.documentTypeId)) continue;
    const inserted = await tx
      .insert(documents)
      .values({
        tripId,
        documentTypeId: w.documentTypeId,
        fileStorageKey: null,
        uploadedByUserId: actorUserId,
        waivedAt: new Date(),
        waivedReason: w.reason,
        waivedByUserId: actorUserId,
      })
      .returning({ id: documents.id });
    await writeAudit(tx, {
      entityType: "document",
      entityId: inserted[0]!.id,
      action: "document.waive",
      previousValue: null,
      newValue: { tripId, documentTypeId: w.documentTypeId, reason: w.reason },
      actorUserId,
    });
  }
}

async function reload(tripId: string): Promise<TripDetail> {
  const detail = await loadTripDetail(db, tripId);
  if (!detail) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");
  return detail;
}

/**
 * Mark a trip Completed (§19.3): gate on `unloaded` + the completion-required documents (after
 * waivers), then `transitionTripStatus(unloaded→completed)` and immediately the §11.6 auto-advance
 * `transitionTripStatus(completed→billing_pending)` + `ensureBillingItem`. Blocked ⇒ `COMPLETION_BLOCKED`.
 */
export async function markCompleted(
  tripId: string,
  input: MarkCompletedInput,
  actorUserId: string,
): Promise<TripDetail> {
  const trip = await loadTripScope(tripId);
  if (!trip) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");

  const required = await resolveRequiredTypes(trip);
  const satisfied = await satisfiedDocumentTypeIds(tripId);
  const waivers = input.waivedRequirements ?? [];
  const augmented = new Set<string>([...satisfied, ...waivers.map((w) => w.documentTypeId)]);
  const { completionMissing } = evaluateChecklist(required, augmented);

  const gate = evaluateCompletionReadiness({
    currentStatus: trip.currentStatus,
    completionMissingDocuments: completionMissing.length,
  });
  if (!gate.canComplete) {
    throw new Conflict("COMPLETION_BLOCKED", "Não é possível concluir: existem pendências.", {
      blockers: gate.blockers,
      missingDocumentTypeIds: completionMissing,
    });
  }

  if (waivers.length) {
    await db.transaction(async (tx) => recordWaivers(tx, tripId, waivers, satisfied, actorUserId));
  }

  // Drive the existing machine (each call opens its own concurrency-guarded transaction).
  await transitionTripStatus(tripId, { toStatus: "completed", expectedFromStatus: "unloaded" }, actorUserId);
  await transitionTripStatus(
    tripId,
    { toStatus: "billing_pending", expectedFromStatus: "completed" },
    actorUserId,
  );
  await db.transaction(async (tx) => ensureBillingItem(tx, tripId));

  return reload(tripId);
}

/**
 * Mark a trip Billing Ready (§19.4): gate on `billing_pending` + billing-required documents (after
 * waivers) + pricing (rate-derived or manual base freight) + no open dispute, then
 * `transitionTripStatus(billing_pending→billing_ready)`. Blocked ⇒ `BILLING_READY_BLOCKED`.
 */
export async function markBillingReady(
  tripId: string,
  input: MarkBillingReadyInput,
  actorUserId: string,
): Promise<TripDetail> {
  const trip = await loadTripScope(tripId);
  if (!trip) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");

  const required = await resolveRequiredTypes(trip);
  const satisfied = await satisfiedDocumentTypeIds(tripId);
  const waivers = input.waivedRequirements ?? [];
  const augmented = new Set<string>([...satisfied, ...waivers.map((w) => w.documentTypeId)]);
  const { billingMissing } = evaluateChecklist(required, augmented);

  const itemRows = await db
    .select({ baseFreightCents: billingItems.baseFreightCents, disputeStatus: billingItems.disputeStatus })
    .from(billingItems)
    .where(eq(billingItems.tripId, tripId))
    .limit(1);
  const item = itemRows[0];
  const hasPricing = item?.baseFreightCents != null;
  const disputeStatus = (item?.disputeStatus ?? "none") as "none" | "open" | "resolved";

  const gate = evaluateBillingReadiness({
    currentStatus: trip.currentStatus,
    billingMissingDocuments: billingMissing.length,
    hasPricing,
    disputeStatus,
  });
  if (!gate.canBillReady) {
    throw new Conflict("BILLING_READY_BLOCKED", "Não é possível marcar como pronta: existem pendências.", {
      blockers: gate.blockers,
      missingDocumentTypeIds: billingMissing,
    });
  }

  if (waivers.length) {
    await db.transaction(async (tx) => recordWaivers(tx, tripId, waivers, satisfied, actorUserId));
  }

  await transitionTripStatus(
    tripId,
    { toStatus: "billing_ready", expectedFromStatus: "billing_pending" },
    actorUserId,
  );

  return reload(tripId);
}
