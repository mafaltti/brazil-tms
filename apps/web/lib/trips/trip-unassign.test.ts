import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  Conflict,
  assignTrip,
  auditLogs,
  customers,
  db,
  drivers,
  locations,
  tripAssignments,
  tripEvents,
  trips,
  unassignTrip,
  users,
  vehicles,
} from "@brazil-tms/db";
import type { TripStatus } from "@brazil-tms/shared";

/**
 * Feature 006 — integration test for `unassignTrip` (US4). Static imports per project convention;
 * skips when DATABASE_URL is unset. To run it:
 *   $env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
 *   pnpm exec vitest run --project web apps/web/lib/trips/trip-unassign.test.ts
 *
 * Un-assigning an `assigned` trip transitions it back to `received` (data-model §4/§6): the current
 * assignment row is SUPERSEDED (is_current=false + superseded_at) and RETAINED as history (never
 * hard-deleted); exactly ONE `status_change` `trip_events` row + ONE `trip.unassign` audit are written.
 * Guards: a stale `current_status`, an illegal-source trip, and a missing trip resolve to
 * `STALE_TRANSITION` / `ILLEGAL_TRANSITION` / `NOT_FOUND`. Seeds + cleans up ALL fixtures (FK-safe).
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("trip-unassign (integration)", () => {
  let actorId = "";
  let customerId = "";
  let originLocationId = "";
  let destinationLocationId = "";
  let driverId = "";
  let vehicleId = "";

  const createdTripIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdVehicleIds: string[] = [];
  const createdLocationIds: string[] = [];
  const createdCustomerIds: string[] = [];

  function code(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  let windowDay = 1;
  async function insertTrip(currentStatus: TripStatus): Promise<string> {
    const day = String(windowDay++).padStart(2, "0");
    const inserted = await db
      .insert(trips)
      .values({
        customerId,
        originLocationId,
        destinationLocationId,
        originalPlan: {},
        currentStatus,
        plannedVehicleType: "truck",
        plannedPickupWindowStart: new Date(`2026-10-${day}T08:00:00.000Z`),
        plannedDeliveryWindowEnd: new Date(`2026-10-${day}T18:00:00.000Z`),
      })
      .returning();
    const id = inserted[0]!.id;
    createdTripIds.push(id);
    return id;
  }

  /** Drive a fresh trip to `assigned` via the real service, returning the trip id. */
  async function seedAssignedTrip(): Promise<string> {
    const tripId = await insertTrip("received");
    await assignTrip(tripId, { driverId, vehicleId, expectedFromStatus: "received" }, actorId);
    return tripId;
  }

  beforeAll(async () => {
    const admin = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "admin@braziltransports.com.br"))
      .limit(1);
    actorId = admin[0]?.id ?? "";
    expect(actorId, "seeded admin must exist (run db:seed)").not.toBe("");

    const cust = await db
      .insert(customers)
      .values({ name: "Cliente Unassign", customerCode: code("CUST-UNA") })
      .returning();
    customerId = cust[0]!.id;
    createdCustomerIds.push(customerId);

    const origin = await db
      .insert(locations)
      .values({ customerId, code: code("ORIG"), name: "Origem Unassign" })
      .returning();
    originLocationId = origin[0]!.id;
    createdLocationIds.push(originLocationId);

    const dest = await db
      .insert(locations)
      .values({ customerId, code: code("DEST"), name: "Destino Unassign" })
      .returning();
    destinationLocationId = dest[0]!.id;
    createdLocationIds.push(destinationLocationId);

    const driver = await db
      .insert(drivers)
      .values({ name: code("Mot"), ownershipType: "owned", status: "active", licenseExpiry: "2030-01-01" })
      .returning();
    driverId = driver[0]!.id;
    createdDriverIds.push(driverId);

    const vehicle = await db
      .insert(vehicles)
      .values({
        plate: `UNA${Date.now().toString(36).slice(-6)}`,
        vehicleType: "truck",
        ownershipType: "owned",
        status: "active",
        documentExpiry: "2030-01-01",
      })
      .returning();
    vehicleId = vehicle[0]!.id;
    createdVehicleIds.push(vehicleId);
  });

  afterAll(async () => {
    for (const id of createdTripIds) {
      await db.delete(tripAssignments).where(eq(tripAssignments.tripId, id));
    }
    for (const id of createdTripIds) {
      await db.delete(tripEvents).where(eq(tripEvents.tripId, id));
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(trips).where(eq(trips.id, id));
    }
    for (const id of createdDriverIds) await db.delete(drivers).where(eq(drivers.id, id));
    for (const id of createdVehicleIds) await db.delete(vehicles).where(eq(vehicles.id, id));
    for (const id of createdLocationIds) await db.delete(locations).where(eq(locations.id, id));
    for (const id of createdCustomerIds) await db.delete(customers).where(eq(customers.id, id));
  });

  it("un-assigns an assigned trip → received, supersedes + retains the current row, one event + one trip.unassign audit", async () => {
    const tripId = await seedAssignedTrip();
    const before = await db
      .select()
      .from(tripAssignments)
      .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.isCurrent, true)));
    const assignmentId = before[0]!.id;

    const { trip } = await unassignTrip(tripId, { expectedFromStatus: "assigned" }, actorId);
    expect(trip.currentStatus).toBe("received");

    // No current assignment remains; the row is RETAINED (still present), not current, superseded.
    const current = await db
      .select()
      .from(tripAssignments)
      .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.isCurrent, true)));
    expect(current).toHaveLength(0);

    const retained = await db
      .select()
      .from(tripAssignments)
      .where(eq(tripAssignments.id, assignmentId));
    expect(retained).toHaveLength(1); // never hard-deleted.
    expect(retained[0]!.isCurrent).toBe(false);
    expect(retained[0]!.supersededAt).not.toBeNull();

    expect(trip.currentAssignment).toBeNull();
    expect(trip.assignmentHistory.map((h) => h.id)).toContain(assignmentId);

    // Exactly one assigned→received status_change event from the unassign.
    const events = await db
      .select()
      .from(tripEvents)
      .where(and(eq(tripEvents.tripId, tripId), eq(tripEvents.eventType, "status_change")));
    const toReceived = events.filter((e) => e.statusAfter === "received");
    expect(toReceived).toHaveLength(1);
    expect(toReceived[0]!.statusBefore).toBe("assigned");

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, tripId), eq(auditLogs.action, "trip.unassign")));
    expect(audits).toHaveLength(1);
  });

  it("rejects un-assigning when the trip is no longer assigned with STALE_TRANSITION", async () => {
    const tripId = await seedAssignedTrip();
    // First unassign succeeds (assigned → received); a second with the stale expectation now fails the
    // guarded UPDATE ... WHERE current_status='assigned' (0 rows).
    await unassignTrip(tripId, { expectedFromStatus: "assigned" }, actorId);
    await expect(
      unassignTrip(tripId, { expectedFromStatus: "assigned" }, actorId),
    ).rejects.toMatchObject({ code: "STALE_TRANSITION" });
    await expect(
      unassignTrip(tripId, { expectedFromStatus: "assigned" }, actorId),
    ).rejects.toBeInstanceOf(Conflict);
  });

  it("rejects with NOT_FOUND for an unknown trip id", async () => {
    await expect(
      unassignTrip(
        "00000000-0000-0000-0000-000000000000",
        { expectedFromStatus: "assigned" },
        actorId,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
