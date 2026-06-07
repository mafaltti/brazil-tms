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
  reassignTrip,
  tripAssignments,
  tripEvents,
  trips,
  users,
  vehicles,
} from "@brazil-tms/db";
import type { AssignTripInput, Finding, TripStatus } from "@brazil-tms/shared";

/**
 * Feature 006 — integration test for `reassignTrip` (US4). Static imports per project convention;
 * skips when DATABASE_URL is unset. To run it:
 *   $env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
 *   pnpm exec vitest run --project web apps/web/lib/trips/trip-reassign.test.ts
 *
 * Reassignment is a PURE assignment-row operation (data-model §4/§6): the trip's `current_status` is
 * UNCHANGED and NO `trip_events` `status_change` row is written. It must leave EXACTLY ONE `is_current`
 * row (the new resources), supersede + RETAIN the prior row (`is_current=false`,
 * `superseded_by_assignment_id` pointing at the new row, `superseded_at` set — never hard-deleted), and
 * write ONE `trip.reassign` audit. Eligibility re-runs on the new resources (BLOCK ⇒ `ASSIGNMENT_BLOCKED`,
 * WARN with no reason ⇒ `OVERRIDE_REQUIRED`). The suite seeds + cleans up ALL its own fixtures (FK-safe).
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("trip-reassign (integration)", () => {
  let actorId = "";
  let customerId = "";
  let originLocationId = "";
  let destinationLocationId = "";
  // First (assigned) pair; second (reassigned) pair; a blocked driver + a van for the re-eval cases.
  let driverAId = "";
  let vehicleAId = "";
  let driverBId = "";
  let vehicleBId = "";
  let blockedDriverId = "";
  let vanVehicleId = "";

  const createdTripIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdVehicleIds: string[] = [];
  const createdLocationIds: string[] = [];
  const createdCustomerIds: string[] = [];

  function code(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
  const plateToken = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.slice(-7);
  let plateSeq = 0;
  function plate(): string {
    return `R${plateToken}${(plateSeq++).toString().padStart(3, "0")}`;
  }

  // Distinct, non-overlapping windows so the reused fleet never trips a stray schedule_overlap WARN.
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
        plannedPickupWindowStart: new Date(`2026-09-${day}T08:00:00.000Z`),
        plannedDeliveryWindowEnd: new Date(`2026-09-${day}T18:00:00.000Z`),
      })
      .returning();
    const id = inserted[0]!.id;
    createdTripIds.push(id);
    return id;
  }

  /** Assign the trip with the A pair (received→assigned), returning the trip id. */
  async function seedAssignedTrip(): Promise<string> {
    const tripId = await insertTrip("received");
    await assignTrip(
      tripId,
      { driverId: driverAId, vehicleId: vehicleAId, expectedFromStatus: "received" },
      actorId,
    );
    return tripId;
  }

  const reassignToB = (over: Partial<AssignTripInput> = {}): AssignTripInput => ({
    driverId: driverBId,
    vehicleId: vehicleBId,
    expectedFromStatus: "assigned",
    ...over,
  });

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
      .values({ name: "Cliente Reassign", customerCode: code("CUST-RSG") })
      .returning();
    customerId = cust[0]!.id;
    createdCustomerIds.push(customerId);

    const origin = await db
      .insert(locations)
      .values({ customerId, code: code("ORIG"), name: "Origem Reassign" })
      .returning();
    originLocationId = origin[0]!.id;
    createdLocationIds.push(originLocationId);

    const dest = await db
      .insert(locations)
      .values({ customerId, code: code("DEST"), name: "Destino Reassign" })
      .returning();
    destinationLocationId = dest[0]!.id;
    createdLocationIds.push(destinationLocationId);

    async function mkDriver(over: Partial<typeof drivers.$inferInsert> = {}): Promise<string> {
      const r = await db
        .insert(drivers)
        .values({ name: code("Mot"), ownershipType: "owned", status: "active", licenseExpiry: "2030-01-01", ...over })
        .returning();
      createdDriverIds.push(r[0]!.id);
      return r[0]!.id;
    }
    async function mkVehicle(over: Partial<typeof vehicles.$inferInsert> = {}): Promise<string> {
      const r = await db
        .insert(vehicles)
        .values({ plate: plate(), vehicleType: "truck", ownershipType: "owned", status: "active", documentExpiry: "2030-01-01", ...over })
        .returning();
      createdVehicleIds.push(r[0]!.id);
      return r[0]!.id;
    }

    driverAId = await mkDriver();
    vehicleAId = await mkVehicle();
    driverBId = await mkDriver();
    vehicleBId = await mkVehicle();
    blockedDriverId = await mkDriver({ status: "blocked" });
    vanVehicleId = await mkVehicle({ vehicleType: "van" });
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

  it("reassigns: one is_current row (new resources), prior row retained + superseded, status unchanged, no new event, one trip.reassign audit", async () => {
    const tripId = await seedAssignedTrip();

    // Capture the original current assignment id (the A pair) before reassigning.
    const before = await db
      .select()
      .from(tripAssignments)
      .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.isCurrent, true)));
    expect(before).toHaveLength(1);
    const originalId = before[0]!.id;

    const { trip } = await reassignTrip(tripId, reassignToB(), actorId);

    // Trip status is UNCHANGED by a reassignment.
    expect(trip.currentStatus).toBe("assigned");

    // Exactly one current row, and it carries the NEW (B) resources.
    const current = await db
      .select()
      .from(tripAssignments)
      .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.isCurrent, true)));
    expect(current).toHaveLength(1);
    expect(current[0]!.driverId).toBe(driverBId);
    expect(current[0]!.vehicleId).toBe(vehicleBId);
    expect(current[0]!.id).not.toBe(originalId);

    // The prior (A) row is RETAINED — still present, not current, superseded, and pointing at the new row.
    const prior = await db
      .select()
      .from(tripAssignments)
      .where(eq(tripAssignments.id, originalId));
    expect(prior).toHaveLength(1);
    expect(prior[0]!.isCurrent).toBe(false);
    expect(prior[0]!.supersededByAssignmentId).toBe(current[0]!.id);
    expect(prior[0]!.supersededAt).not.toBeNull();

    // The detail reflects the supersession: current = B row, history holds the A row.
    expect(trip.currentAssignment!.id).toBe(current[0]!.id);
    expect(trip.assignmentHistory.map((h) => h.id)).toContain(originalId);

    // Reassignment writes NO new status_change event: still exactly the ONE from the original assign.
    const events = await db
      .select()
      .from(tripEvents)
      .where(and(eq(tripEvents.tripId, tripId), eq(tripEvents.eventType, "status_change")));
    expect(events).toHaveLength(1);
    expect(events[0]!.statusAfter).toBe("assigned");

    // Exactly one trip.reassign audit.
    const reassignAudits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, tripId), eq(auditLogs.action, "trip.reassign")));
    expect(reassignAudits).toHaveLength(1);
  });

  it("re-runs eligibility on reassign: a blocked driver ⇒ ASSIGNMENT_BLOCKED (prior assignment untouched)", async () => {
    const tripId = await seedAssignedTrip();
    let caught: unknown;
    try {
      await reassignTrip(tripId, reassignToB({ driverId: blockedDriverId }), actorId);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Conflict);
    expect((caught as Conflict).code).toBe("ASSIGNMENT_BLOCKED");

    // Refused ⇒ the original (A) assignment is still the single current row.
    const current = await db
      .select()
      .from(tripAssignments)
      .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.isCurrent, true)));
    expect(current).toHaveLength(1);
    expect(current[0]!.driverId).toBe(driverAId);
  });

  it("re-runs eligibility on reassign: a WARN with no override reason ⇒ OVERRIDE_REQUIRED (findings attached)", async () => {
    const tripId = await seedAssignedTrip();
    let caught: unknown;
    try {
      // A van vs the trip's planned truck ⇒ type_mismatch WARN, with no override reason.
      await reassignTrip(tripId, reassignToB({ vehicleId: vanVehicleId }), actorId);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Conflict);
    expect((caught as Conflict).code).toBe("OVERRIDE_REQUIRED");
    const details = (caught as Conflict).details as Finding[];
    expect(details.some((f) => f.code === "type_mismatch" && f.severity === "warn")).toBe(true);

    // Still the original (A) current row.
    const current = await db
      .select()
      .from(tripAssignments)
      .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.isCurrent, true)));
    expect(current[0]!.vehicleId).toBe(vehicleAId);
  });

  it("reassign with an illegal expectedFromStatus (not assigned/confirmed) ⇒ ILLEGAL_TRANSITION, no state change", async () => {
    const tripId = await seedAssignedTrip();
    let caught: unknown;
    try {
      await reassignTrip(tripId, reassignToB({ expectedFromStatus: "in_transit" }), actorId);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Conflict);
    expect((caught as Conflict).code).toBe("ILLEGAL_TRANSITION");
    // Untouched: the original A assignment is still the single current row.
    const current = await db
      .select()
      .from(tripAssignments)
      .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.isCurrent, true)));
    expect(current).toHaveLength(1);
    expect(current[0]!.driverId).toBe(driverAId);
  });

  it("reassign whose expectedFromStatus ≠ the trip's actual status ⇒ STALE_TRANSITION, no state change", async () => {
    const tripId = await seedAssignedTrip(); // actually `assigned`
    let caught: unknown;
    try {
      // Caller believes it is `confirmed` (a reassignable status) but it is still `assigned`.
      await reassignTrip(tripId, reassignToB({ expectedFromStatus: "confirmed" }), actorId);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Conflict);
    expect((caught as Conflict).code).toBe("STALE_TRANSITION");
    const current = await db
      .select()
      .from(tripAssignments)
      .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.isCurrent, true)));
    expect(current[0]!.driverId).toBe(driverAId); // unchanged
  });

  it("reassign is legal from `confirmed` (status unchanged; supersede + new current row)", async () => {
    const tripId = await seedAssignedTrip();
    // Move to `confirmed` (the current assignment row stays current) to exercise confirmed→reassign.
    await db.update(trips).set({ currentStatus: "confirmed" }).where(eq(trips.id, tripId));

    const { trip } = await reassignTrip(
      tripId,
      reassignToB({ expectedFromStatus: "confirmed" }),
      actorId,
    );
    expect(trip.currentStatus).toBe("confirmed"); // a reassignment never changes status
    const current = await db
      .select()
      .from(tripAssignments)
      .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.isCurrent, true)));
    expect(current).toHaveLength(1);
    expect(current[0]!.driverId).toBe(driverBId);
  });
});
