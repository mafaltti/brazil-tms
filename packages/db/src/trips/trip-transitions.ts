import { and, eq } from "drizzle-orm";
import { db, type DB } from "../client";
import { tripEvents, trips } from "../../schema";
import { canTransition, type TransitionTripInput } from "@brazil-tms/shared";
import { writeAudit } from "../audit/write-audit";
import { Conflict } from "../errors";
import { recomputeTripSla } from "./sla";
import { loadTripDetail, type TripDetail } from "./trip-dto";

/** The transaction handle passed to a {@link transitionTripStatus} `txHook` (the inner `tx`). */
export type TripTransitionTx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/**
 * Atomic, status-guarded trip status transition (R7, FR-008..FR-012; contract:
 * contracts/trip-domain-api.md §transitionTripStatus). The ONE place a trip changes status.
 *
 * Legality is checked against the SHARED `canTransition` table (the single source of truth in
 * `@brazil-tms/shared`) BEFORE the transaction opens, so an illegal transition changes NO state
 * (SC-001). For `expectedFromStatus === "disputed"`, the trip's recorded `disputed_from_status` is
 * the additional allowed target (the dispute round-trip, FR-011).
 *
 * Concurrency safety (R7) is optimistic: the `UPDATE ... WHERE current_status = expectedFrom`
 * returns zero rows when another actor already moved the trip → `STALE_TRANSITION`. The trips row
 * update, the `trip_events` status_change row, and the `trip.status_change` audit all commit in the
 * SAME transaction, so a transition is never half-recorded (SC-003).
 *
 * `txHook` (optional) runs INSIDE that same transaction, AFTER the guarded update (so it only runs
 * when the transition actually applied — a `STALE_TRANSITION` rolls everything back and the hook
 * never fires). A caller uses it to make a side-write atomic with the status change — e.g. 008's
 * billing export links `billing_items.export_batch_id` in the same tx as `billing_ready → billed`,
 * so a crash can never leave a trip billed-but-unlinked (FR-021).
 */
export async function transitionTripStatus(
  tripId: string,
  args: TransitionTripInput,
  actorUserId: string,
  txHook?: (tx: TripTransitionTx) => Promise<void>,
): Promise<TripDetail> {
  const currentRows = await db
    .select({ currentStatus: trips.currentStatus, disputedFromStatus: trips.disputedFromStatus })
    .from(trips)
    .where(eq(trips.id, tripId))
    .limit(1);
  const current = currentRows[0];
  if (!current) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");

  // Legality is judged against the CALLER's belief (expectedFromStatus); the row's actual status is
  // re-checked atomically by the guarded update below. Rejected here = no transaction, no state change.
  if (
    !canTransition(args.expectedFromStatus, args.toStatus, {
      disputedFromStatus: current.disputedFromStatus,
    })
  ) {
    throw new Conflict("ILLEGAL_TRANSITION", "Transição de status não permitida.");
  }

  // Record where a dispute was entered from (for the round-trip) / clear it on resolution.
  const disputedField =
    args.toStatus === "disputed"
      ? { disputedFromStatus: args.expectedFromStatus }
      : args.expectedFromStatus === "disputed"
        ? { disputedFromStatus: null }
        : {};

  return db.transaction(async (tx) => {
    // Optimistic-concurrency guard (R7): only flip the row that is STILL at the expected status.
    const updated = await tx
      .update(trips)
      .set({ currentStatus: args.toStatus, updatedAt: new Date(), ...disputedField })
      .where(and(eq(trips.id, tripId), eq(trips.currentStatus, args.expectedFromStatus)))
      .returning();
    if (updated.length === 0) {
      // 0 rows = the trip moved out of `expectedFromStatus` first (someone beat us to it).
      throw new Conflict("STALE_TRANSITION", "A viagem já mudou de status.");
    }

    await tx.insert(tripEvents).values({
      tripId,
      eventType: "status_change",
      statusBefore: args.expectedFromStatus,
      statusAfter: args.toStatus,
      eventTimestamp: args.eventTimestamp ?? null,
      source: args.source ?? "system",
      actorUserId,
      notes: args.notes ?? null,
    });

    await writeAudit(tx, {
      entityType: "trip",
      entityId: tripId,
      action: "trip.status_change",
      previousValue: { currentStatus: args.expectedFromStatus },
      newValue: { currentStatus: args.toStatus },
      actorUserId,
    });

    // Feature 007 — a recorded milestone flips SLA risk immediately (terminal trips short-circuit
    // inside recompute). Runs in-tx after the transition commits so the returned detail is fresh.
    await recomputeTripSla(tx, tripId);

    // Optional caller side-write, atomic with the transition (008 billing-export link). A throw here
    // rolls back the whole transition (the status change never applies).
    if (txHook) await txHook(tx);

    const detail = await loadTripDetail(tx, tripId);
    if (!detail) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");
    return detail;
  });
}
