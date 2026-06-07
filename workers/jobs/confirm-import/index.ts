import type { PgBoss } from "pg-boss";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  Conflict,
  createTrip,
  db,
  importBatches,
  importRows,
  trips,
  updateTripPlan,
  writeAudit,
} from "@brazil-tms/db";
import {
  createTripSchema,
  type ConfirmPayload,
  type TripPlanFields,
} from "@brazil-tms/shared";
import { setBatchCounts, setBatchStatus } from "../../lib/batch-progress";
import { JOB, work } from "../../lib/queue";
import { runGenerateErrorReport } from "../generate-error-report";

/**
 * T033 — `import.confirm` job (data-model R8; contract §C/§A). Per row best-effort + idempotent: for
 * each `valid`/`warning` row with `applied_at IS NULL`, call the PROMOTED 003 trip-write services
 * (`createTrip`/`updateTripPlan`) — never re-implementing trip creation, the status machine, or the
 * audit. Newly created trips are born `validated` (slice 014, FR-009): the trip-level validation gate
 * (PRD §11) is already satisfied by import-time per-row validation, so a passing imported row IS a
 * validated trip — `createTrip` is called with `initialStatus = "validated"` (atomic, in one tx). Import
 * never changes an EXISTING trip's status: the `updateTripPlan` paths (update + unique-race fallback)
 * and `no_op` are status-neutral, so an already-`assigned`/`in_transit` trip keeps its status (FR-002).
 *
 * IDEMPOTENCY: a row's `applied_at`/`target_trip_id` guard makes a re-run skip already-applied rows,
 * so re-running creates 0 new trips. The trips partial unique index `(customer_id, external_trip_id)`
 * is the race backstop: a `new` row that loses the race to a 23505 is RE-RESOLVED as update.
 *
 * US3 (T046): a `potential_duplicate` row is a `warning` that IS applied — it had no external-id match,
 * so it creates a NEW trip (treated exactly like `new`), carrying its already-recorded POTENTIAL_DUPLICATE
 * reason on the import row (FR-022; it is NOT skipped). An `update` to a trip moved PAST `confirmed`
 * surfaces `Conflict('REVIEW_REQUIRED')` from `updateTripPlan`: that row is marked NEEDS-REVIEW (reason
 * appended, `applied_at`/`target_trip_id` left NULL — reported, not dropped, not silently applied,
 * FR-024) and the batch continues.
 *
 * A per-row failure is recorded (reason appended) and does NOT abort the batch.
 */

const PG_UNIQUE_VIOLATION = "23505";

/** Walk the Drizzle error cause chain for a Postgres unique-violation (SQLSTATE 23505). */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      (current as { code?: unknown }).code === PG_UNIQUE_VIOLATION
    ) {
      return true;
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

/** The plan-only subset of the parsed create input (what `updateTripPlan` accepts). */
function planChangesFrom(
  input: ReturnType<typeof createTripSchema.parse>,
): TripPlanFields {
  return {
    plannedPickupWindowStart: input.plannedPickupWindowStart ?? null,
    plannedPickupWindowEnd: input.plannedPickupWindowEnd ?? null,
    plannedDeliveryWindowStart: input.plannedDeliveryWindowStart ?? null,
    plannedDeliveryWindowEnd: input.plannedDeliveryWindowEnd ?? null,
    plannedVehicleType: input.plannedVehicleType ?? null,
    plannedVolumeUnits: input.plannedVolumeUnits ?? null,
    plannedWeightKg: input.plannedWeightKg ?? null,
    plannedPalletCount: input.plannedPalletCount ?? null,
    plannedRouteNotes: input.plannedRouteNotes ?? null,
    plannedServiceRequirements: input.plannedServiceRequirements ?? null,
  };
}

/** Find an existing trip by the match key (customer, external_trip_id); null when absent. */
async function findExistingTrip(
  customerId: string,
  externalTripId: string,
): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: trips.id })
    .from(trips)
    .where(and(eq(trips.customerId, customerId), eq(trips.externalTripId, externalTripId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function runConfirm(payload: ConfirmPayload): Promise<void> {
  const { batchId, actorUserId } = payload;
  await setBatchStatus(batchId, "confirming");

  const batchRows = await db
    .select()
    .from(importBatches)
    .where(eq(importBatches.id, batchId))
    .limit(1);
  const batch = batchRows[0];
  if (!batch) return;

  const pending = await db
    .select()
    .from(importRows)
    .where(
      and(
        eq(importRows.importBatchId, batchId),
        inArray(importRows.outcome, ["valid", "warning"]),
      ),
    )
    .orderBy(asc(importRows.rowNumber));

  for (const row of pending) {
    if (row.appliedAt != null) continue; // idempotency guard: already applied

    const mapped = (row.mapped ?? {}) as Record<string, unknown>;
    let targetTripId: string | null = null;

    try {
      const input = createTripSchema.parse({
        customerId: batch.customerId,
        externalTripId: mapped.externalTripId ?? null,
        importBatchId: batchId,
        originLocationId: mapped.originLocationId,
        destinationLocationId: mapped.destinationLocationId,
        plannedPickupWindowStart: mapped.plannedPickupWindowStart ?? null,
        plannedPickupWindowEnd: mapped.plannedPickupWindowEnd ?? null,
        plannedDeliveryWindowStart: mapped.plannedDeliveryWindowStart ?? null,
        plannedDeliveryWindowEnd: mapped.plannedDeliveryWindowEnd ?? null,
        plannedVehicleType: mapped.plannedVehicleType ?? null,
        plannedVolumeUnits: mapped.plannedVolumeUnits ?? null,
        plannedWeightKg: mapped.plannedWeightKg ?? null,
        plannedPalletCount: mapped.plannedPalletCount ?? null,
        plannedRouteNotes: mapped.plannedRouteNotes ?? null,
        plannedServiceRequirements: mapped.plannedServiceRequirements ?? null,
      });
      const planChanges = planChangesFrom(input);
      const externalTripId = input.externalTripId ?? "";

      if (row.matchDecision === "new" || row.matchDecision === "potential_duplicate") {
        // A potential_duplicate had NO external-id match → it creates a NEW trip, exactly like `new`.
        // Its POTENTIAL_DUPLICATE reason already lives on the import row; we do not drop or skip it.
        try {
          // Born validated (slice 014): a passing imported row IS a validated trip.
          const trip = await createTrip(input, actorUserId, "validated");
          targetTripId = trip.id;
        } catch (err) {
          // Race backstop: a concurrent insert won the partial-unique index → re-resolve as update.
          if (isUniqueViolation(err) && externalTripId) {
            const existing = await findExistingTrip(batch.customerId, externalTripId);
            if (!existing) throw err;
            await updateTripPlan(existing.id, planChanges, {}, actorUserId);
            targetTripId = existing.id;
          } else {
            throw err;
          }
        }
      } else if (row.matchDecision === "update") {
        const existing = externalTripId
          ? await findExistingTrip(batch.customerId, externalTripId)
          : null;
        if (existing) {
          await updateTripPlan(existing.id, planChanges, {}, actorUserId);
          targetTripId = existing.id;
        } else {
          // The matched trip vanished between detection and confirm → create it (born validated, slice 014).
          const trip = await createTrip(input, actorUserId, "validated");
          targetTripId = trip.id;
        }
      } else if (row.matchDecision === "no_op") {
        const existing = externalTripId
          ? await findExistingTrip(batch.customerId, externalTripId)
          : null;
        targetTripId = existing?.id ?? null;
      }

      await db
        .update(importRows)
        .set({ targetTripId, appliedAt: new Date() })
        .where(eq(importRows.id, row.id));
    } catch (err) {
      // Per-row failure: record + continue (never abort the batch). Two distinct kinds:
      //  - REVIEW_REQUIRED (the trip is past `confirmed`): TERMINAL for import — a re-run hits the same
      //    gate (import never passes `authorizedReview`), so retrying is futile. Mark it `error` so it
      //    is counted, shown, and included in the regenerated report (FR-024), and NOT retried.
      //  - any other (unexpected/transient) failure: keep the row's `outcome` (valid/warning) and leave
      //    `applied_at` NULL so a RE-CONFIRM retries it (R8 idempotency). The reason is recorded for
      //    visibility, and the batch is held at `validated` (below) so the operator can retry.
      const isReviewRequired = err instanceof Conflict && err.code === "REVIEW_REQUIRED";
      const code = err instanceof Conflict ? err.code : "APPLY_FAILED";
      const message = isReviewRequired
        ? "A viagem já passou da confirmação; a atualização exige revisão autorizada (não aplicada)."
        : `Falha ao aplicar a linha (será re-tentada em nova confirmação): ${(err as Error).message}`;
      const existingReasons = Array.isArray(row.reasons)
        ? (row.reasons as { code: string; field?: string; message: string }[])
        : [];
      await db
        .update(importRows)
        .set({
          reasons: [...existingReasons, { code, message }],
          // Only REVIEW_REQUIRED is terminal → mark `error`. Transient failures keep their outcome so
          // they remain in the confirm `pending` set (valid/warning + applied_at NULL) for a re-run.
          ...(isReviewRequired ? { outcome: "error" as const } : {}),
        })
        .where(eq(importRows.id, row.id));
    }
  }

  // Recompute the applied tallies from the rows themselves (idempotent across re-runs): a row that
  // resulted in a NEW trip has no prior trip; an UPDATE row targeted an existing one. We count by the
  // match decision among applied rows so totals reflect this run + any prior partial runs.
  const applied = await db
    .select({ matchDecision: importRows.matchDecision })
    .from(importRows)
    .where(and(eq(importRows.importBatchId, batchId), isNotNull(importRows.appliedAt)))
    .orderBy(asc(importRows.rowNumber));

  // A `potential_duplicate` row that applied also created a NEW trip, so it counts toward created.
  const createdCount = applied.filter(
    (r) => r.matchDecision === "new" || r.matchDecision === "potential_duplicate",
  ).length;
  const updatedCount = applied.filter((r) => r.matchDecision === "update").length;
  const errorRows = await db
    .select({ id: importRows.id })
    .from(importRows)
    .where(and(eq(importRows.importBatchId, batchId), eq(importRows.outcome, "error")));
  const errorCount = errorRows.length;

  await setBatchCounts(batchId, { createdCount, updatedCount, errorCount });
  // Confirm may have newly marked rows `error` (REVIEW_REQUIRED). Regenerate the downloadable error
  // report so it reflects post-confirm failures too (idempotent — overwrites the key).
  if (errorCount > 0) await runGenerateErrorReport({ batchId });

  // A row still `valid`/`warning` with `applied_at IS NULL` is RETRYABLE — it was either never reached
  // (a crash/interruption mid-confirm) or hit a transient apply failure. Hold the batch at `validated`
  // so the UI re-enables Confirm and a re-run applies exactly those rows (R8: re-run skips applied rows,
  // retries the rest, never duplicates). Only when nothing retryable remains is the batch `completed`.
  const retryable = await db
    .select({ id: importRows.id })
    .from(importRows)
    .where(
      and(
        eq(importRows.importBatchId, batchId),
        inArray(importRows.outcome, ["valid", "warning"]),
        isNull(importRows.appliedAt),
      ),
    )
    .limit(1);
  await setBatchStatus(batchId, retryable.length > 0 ? "validated" : "completed");

  // Audit the confirm at the batch level. `db` satisfies the writeAudit `Inserter` (Pick<DB,"insert">).
  await writeAudit(db, {
    entityType: "import_batch",
    entityId: batchId,
    action: "import.confirm",
    previousValue: null,
    newValue: { createdCount, updatedCount, errorCount },
    actorUserId,
  });
}

export async function registerConfirm(boss: PgBoss): Promise<void> {
  await work(boss, JOB.confirm, async (payload) => {
    await runConfirm(payload);
  });
}
