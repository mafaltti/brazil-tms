import "server-only";
import { and, eq } from "drizzle-orm";
import { createTrip, db, trips, updateTripPlan, type TripDetail } from "@brazil-tms/db";
import type { CreateTripInput, TripPlanFields } from "@brazil-tms/shared";

/**
 * Manual single-trip create (feature 004, T055, US6). Mirrors the import-confirm match semantics so a
 * hand-entered trip and an imported one converge on ONE row keyed on `(customer, external trip id)`:
 * an existing match is updated (no duplicate trip); otherwise a new trip is created. Manual trips
 * carry NO import batch, so `import_batch_id` is forced to null. This never redefines the trip domain
 * (003) — it calls the promoted `createTrip` / `updateTripPlan` services.
 */

/** The live planned_* fields `updateTripPlan` accepts (the immutable original_plan is never touched). */
function planFields(input: CreateTripInput): TripPlanFields {
  return {
    plannedPickupWindowStart: input.plannedPickupWindowStart,
    plannedPickupWindowEnd: input.plannedPickupWindowEnd,
    plannedDeliveryWindowStart: input.plannedDeliveryWindowStart,
    plannedDeliveryWindowEnd: input.plannedDeliveryWindowEnd,
    plannedVehicleType: input.plannedVehicleType,
    plannedVolumeUnits: input.plannedVolumeUnits,
    plannedWeightKg: input.plannedWeightKg,
    plannedPalletCount: input.plannedPalletCount,
    plannedRouteNotes: input.plannedRouteNotes,
    plannedServiceRequirements: input.plannedServiceRequirements,
  };
}

export interface ManualCreateResult {
  item: TripDetail;
  /** `true` when an existing `(customer, externalTripId)` match was updated rather than created. */
  updated: boolean;
}

/**
 * Create or update a single trip manually. When the input carries an `externalTripId` and a trip
 * already exists for `(customerId, externalTripId)`, the live plan is updated via `updateTripPlan`
 * (which only audits on a critical-field change — an identical re-entry is effectively a no-op).
 * Otherwise a fresh trip is created in `received` with `import_batch_id` NULL.
 */
export async function createOrUpdateTripManually(
  input: CreateTripInput,
  actorUserId: string,
): Promise<ManualCreateResult> {
  if (input.externalTripId) {
    const existing = await db
      .select({ id: trips.id })
      .from(trips)
      .where(
        and(
          eq(trips.customerId, input.customerId),
          eq(trips.externalTripId, input.externalTripId),
        ),
      )
      .limit(1);
    const match = existing[0];
    if (match) {
      const item = await updateTripPlan(match.id, planFields(input), {}, actorUserId);
      return { item, updated: true };
    }
  }

  const item = await createTrip({ ...input, importBatchId: null }, actorUserId);
  return { item, updated: false };
}
