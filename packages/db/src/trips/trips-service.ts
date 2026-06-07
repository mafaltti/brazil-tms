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
 * The only statuses a trip may be BORN at: `received` (default) or `validated` (import, slice 014).
 * Any LATER status MUST be reached through the guarded `transitionTripStatus`, so the required
 * assignment rows, `status_change` events, billing/cancellation side effects, and transition audit
 * actually happen — `createTrip` writes ONLY the trip row + its `trip.create` audit. Keeping this
 * narrow prevents a caller from minting a trip directly in `assigned`/`confirmed`/`cancelled`/etc.
 */
export type InitialTripStatus = "received" | "validated";

/**
 * Create a trip and snapshot its plan. `original_plan` captures the create payload verbatim and is
 * written exactly once — no later service overwrites it (SC-002). The live `planned_*` columns are
 * seeded from the same input (the CURRENT accepted plan, R4). A single `trip.create` audit row is
 * written in the same transaction as the insert (SC-003).
 *
 * `initialStatus` (slice 014) is the trip's born status — default `received` preserves every existing
 * caller; `confirm-import` passes `validated` so an imported trip is born validated, atomically, in this
 * one transaction (never first persisted as `received`). It is an *initial* INSERT status, not a
 * transition — transitions out of it still route through the guarded `transitionTripStatus`.
 */
export async function createTrip(
  input: CreateTripInput,
  actorUserId: string,
  initialStatus: InitialTripStatus = "received",
): Promise<TripDetail> {
  // Defence-in-depth for this system-of-record write: a trip may only be BORN `received` or
  // `validated`. The param type enforces this for TS callers; this guards an `as`-cast / non-TS
  // caller from minting a trip in a status that skips its required side effects + guarded audit.
  if (initialStatus !== "received" && initialStatus !== "validated") {
    throw new Error(
      `createTrip: a trip can only be born "received" or "validated", not "${initialStatus}". ` +
        "Use transitionTripStatus for any later status.",
    );
  }

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
        currentStatus: initialStatus,
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
      newValue: { currentStatus: initialStatus, originalPlan },
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
