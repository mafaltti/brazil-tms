import { eq } from "drizzle-orm";
import { db } from "../client";
import { tripEvents, trips } from "../../schema";
import { type AddTripNoteInput } from "@brazil-tms/shared";
import { writeAudit } from "../audit/write-audit";
import { Conflict } from "../errors";
import { recomputeTripSla } from "./sla";
import { loadTripDetail, type TripDetail } from "./trip-dto";

/**
 * Feature 007 — append a free-form note to a trip (data-model §11.3, FR-004/EVT-003). A note is a
 * `trip_events` row with `event_type='note'` and NO status change — it never touches `current_status`.
 * Mirrors `transitionTripStatus`: one transaction inserts the append-only event, writes the
 * `trip.note` audit, recomputes SLA (cheap; an `exception_id`-linked note may matter later), and
 * returns the freshly-loaded `TripDetail`. `trip_events` stays append-only (insert + select only).
 */
export async function addTripNote(
  tripId: string,
  input: AddTripNoteInput,
  actorUserId: string,
): Promise<TripDetail> {
  const exists = await db.select({ id: trips.id }).from(trips).where(eq(trips.id, tripId)).limit(1);
  if (!exists[0]) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");

  return db.transaction(async (tx) => {
    await tx.insert(tripEvents).values({
      tripId,
      eventType: "note",
      source: "operator_manual",
      notes: input.notes,
      locationId: input.locationId ?? null,
      exceptionId: input.exceptionId ?? null,
      eventTimestamp: input.eventTimestamp ?? null,
      actorUserId,
    });

    await writeAudit(tx, {
      entityType: "trip",
      entityId: tripId,
      action: "trip.note",
      previousValue: null,
      newValue: { notes: input.notes, exceptionId: input.exceptionId ?? null },
      actorUserId,
    });

    await recomputeTripSla(tx, tripId);

    const detail = await loadTripDetail(tx, tripId);
    if (!detail) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");
    return detail;
  });
}
