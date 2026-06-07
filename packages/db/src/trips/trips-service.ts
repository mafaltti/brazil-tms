import { and, desc, eq, ilike } from "drizzle-orm";
import { db } from "../client";
import { trips } from "../../schema";
import { TRIP_STATUSES, type CreateTripInput, type TripStatus } from "@brazil-tms/shared";
import { writeAudit } from "../audit/write-audit";
import {
  loadTripDetail,
  toTripSummary,
  type TripDetail,
  type TripSummary,
} from "./trip-dto";

/**
 * Durable-trip service (US1; FR-001..FR-004, FR-006, FR-007). Creates the operations
 * system-of-record row, snapshots the imported plan into the IMMUTABLE `original_plan` jsonb (written
 * once, never overwritten — SC-002), and exposes the read paths used by the inspector. Every return
 * value is the shared `TripDetail`/`TripSummary` shape from `trip-dto` (DRY — one mapping for all
 * producers). The billing phase is the derived projection (R3); there is no stored column.
 */

export type { TripDetail, TripSummary } from "./trip-dto";

/**
 * Create a trip and snapshot its plan. `original_plan` captures the create payload verbatim and is
 * written exactly once — no later service overwrites it (SC-002). The live `planned_*` columns are
 * seeded from the same input (the CURRENT accepted plan, R4). A single `trip.create` audit row is
 * written in the same transaction as the insert (SC-003).
 *
 * Every trip is BORN `received` (slice 015 reverted slice 014's `initialStatus` param — with the
 * validation states collapsed, `received` is itself the first dispatchable status, so import no longer
 * births trips `validated`). Any LATER status MUST be reached through the guarded `transitionTripStatus`
 * so the required assignment rows, `status_change` events, billing/cancellation side effects, and
 * transition audit actually happen — `createTrip` writes ONLY the trip row + its `trip.create` audit.
 */
export async function createTrip(
  input: CreateTripInput,
  actorUserId: string,
): Promise<TripDetail> {
  // The immutable snapshot of the imported/seeded plan (data-model §1, R4). Written once.
  const originalPlan = {
    customerId: input.customerId,
    externalTripId: input.externalTripId ?? null,
    importBatchId: input.importBatchId ?? null,
    originLocationId: input.originLocationId,
    destinationLocationId: input.destinationLocationId,
    laneId: input.laneId ?? null,
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

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(trips)
      .values({
        customerId: input.customerId,
        externalTripId: input.externalTripId ?? null,
        importBatchId: input.importBatchId ?? null,
        originLocationId: input.originLocationId,
        destinationLocationId: input.destinationLocationId,
        laneId: input.laneId ?? null,
        currentStatus: "received",
        originalPlan,
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
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error("Inserção de viagem não retornou linha.");

    await writeAudit(tx, {
      entityType: "trip",
      entityId: row.id,
      action: "trip.create",
      previousValue: null,
      newValue: { currentStatus: "received", originalPlan },
      actorUserId,
    });

    const detail = await loadTripDetail(tx, row.id);
    if (!detail) throw new Error("Viagem recém-criada não encontrada.");
    return detail;
  });
}

/** Read a trip's full detail (events + audit + billing projection). Null → route maps to 404. */
export async function getTrip(tripId: string): Promise<TripDetail | null> {
  return loadTripDetail(db, tripId);
}

export interface ListTripsOptions {
  status?: string;
  customerId?: string;
  q?: string;
  limit?: number;
}

/**
 * List trips (newest first) with optional filters: status (only when a valid `trip_status`),
 * customer, and a substring match on the customer's `external_trip_id`. Returns the summary shape.
 */
export async function listTrips(opts: ListTripsOptions = {}): Promise<TripSummary[]> {
  const filters = [];
  if (opts.status && (TRIP_STATUSES as readonly string[]).includes(opts.status)) {
    filters.push(eq(trips.currentStatus, opts.status as TripStatus));
  }
  if (opts.customerId) filters.push(eq(trips.customerId, opts.customerId));
  if (opts.q) filters.push(ilike(trips.externalTripId, `%${opts.q}%`));

  const rows = await db
    .select()
    .from(trips)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(trips.createdAt))
    .limit(opts.limit ?? 50);
  return rows.map(toTripSummary);
}
