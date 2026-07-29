import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  Conflict,
  assignTrip,
  auditLogs,
  carriers,
  confirmTripAssignment,
  customers,
  db,
  drivers,
  locations,
  tripAssignments,
  tripEvents,
  trips,
  users,
  vehicles,
} from "@brazil-tms/db";
import type { AssignTripInput, TripStatus } from "@brazil-tms/shared";

/**
 * Feature 006 — integration test for the dispatch assignment services (US1) against the live dev DB.
 * Static imports per project convention (`test.skipIf` on a lazily-imported module does NOT work);
 * the Drizzle `db` connects lazily, so importing is safe. Skips when DATABASE_URL is unset so the
 * default `pnpm test` stays green. To run it:
 *   $env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
 *   pnpm exec vitest run --project web apps/web/lib/trips/trip-assignments.test.ts
 *
 * Focus (T036/T037): the assign happy path (`received→assigned` + exactly one `is_current` row +
 * `assigned_by/at` + notes + ONE `trip.assign` audit; slice 015 retargeted the source off the removed
 * `validated` state), `INCOMPLETE_ASSIGNMENT` (driver only),
 * `STALE_TRANSITION` (assign when not `received`), `confirmTripAssignment` (`assigned→confirmed` +
 * `confirmed_by/at` + ONE `trip.confirm` audit), and the single-current-assignment integrity guard —
 * a second `is_current=true` INSERT for the same trip raises SQLSTATE `23505` (asserted via the
 * `error.cause.code` walk, since a `DrizzleQueryError` wraps the pg error).
 *
 * Each case uses a DISTINCT trip and the suite seeds + cleans up ALL its own fixtures (FK-safe).
 */
const hasDb = Boolean(process.env.DATABASE_URL);

/** Walk an error's `cause` chain to find a pg SQLSTATE `code` (DrizzleQueryError wraps the pg error). */
function findSqlState(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 10 && cur != null; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

describe.skipIf(!hasDb)("trip-assignments (integration)", () => {
  let actorId = "";
  let customerId = "";
  let originLocationId = "";
  let destinationLocationId = "";
  // An owned driver + matching vehicle so a driver+vehicle pair forms a complete, conflict-free set.
  let driverId = "";
  let vehicleId = "";

  const createdTripIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdVehicleIds: string[] = [];
  const createdCarrierIds: string[] = [];
  const createdLocationIds: string[] = [];
  const createdCustomerIds: string[] = [];

  function code(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  // The shared driver/vehicle are reused across cases, so each trip gets a DISTINCT, non-overlapping
  // planned window — otherwise the prior case's current assignment would surface a `schedule_overlap`
  // WARN on the next assign (research §6). One day per trip keeps the intervals disjoint.
  let windowDay = 1;
  function nextWindow(): { start: Date; end: Date } {
    const day = String(windowDay++).padStart(2, "0");
    return {
      start: new Date(`2026-07-${day}T08:00:00.000Z`),
      end: new Date(`2026-07-${day}T18:00:00.000Z`),
    };
  }

  /** Insert a fresh trip at a chosen status (with a distinct, non-overlapping window); tracked for cleanup. */
  async function insertTrip(currentStatus: TripStatus): Promise<string> {
    const { start, end } = nextWindow();
    const inserted = await db
      .insert(trips)
      .values({
        customerId,
        originLocationId,
        destinationLocationId,
        originalPlan: {},
        currentStatus,
        plannedVehicleType: "truck",
        plannedPickupWindowStart: start,
        plannedDeliveryWindowEnd: end,
      })
      .returning();
    const id = inserted[0]!.id;
    createdTripIds.push(id);
    return id;
  }

  /** A complete, conflict-free assignment input (owned active driver + matching active vehicle). */
  const fullInput = (overrides: Partial<AssignTripInput> = {}): AssignTripInput => ({
    driverId,
    vehicleId,
    expectedFromStatus: "received",
    ...overrides,
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
      .values({ name: "Cliente Atribuicao", customerCode: code("CUST-ASG") })
      .returning();
    customerId = cust[0]!.id;
    createdCustomerIds.push(customerId);

    const origin = await db
      .insert(locations)
      .values({ customerId, code: code("ORIG"), name: "Origem Atribuicao" })
      .returning();
    originLocationId = origin[0]!.id;
    createdLocationIds.push(originLocationId);

    const dest = await db
      .insert(locations)
      .values({ customerId, code: code("DEST"), name: "Destino Atribuicao" })
      .returning();
    destinationLocationId = dest[0]!.id;
    createdLocationIds.push(destinationLocationId);

    // An OWNED active driver (no carrier ⇒ owned-case ⇒ carrier NOT required) with a far-future
    // license so no documentation finding fires.
    const driver = await db
      .insert(drivers)
      .values({
        name: code("Motorista"),
        ownershipType: "owned",
        status: "active",
        licenseExpiry: "2030-01-01",
      })
      .returning();
    driverId = driver[0]!.id;
    createdDriverIds.push(driverId);

    // An OWNED active `truck` vehicle (matches the seeded trip's planned type) with far-future docs.
    const vehicle = await db
      .insert(vehicles)
      .values({
        plate: code("PLT").slice(0, 12),
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
    // FK-safe order: assignments → trip children (events + audit) → trips → fleet → locations → customers.
    for (const id of createdTripIds) {
      await db.delete(tripAssignments).where(eq(tripAssignments.tripId, id));
    }
    for (const id of createdTripIds) {
      await db.delete(tripEvents).where(eq(tripEvents.tripId, id));
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(trips).where(eq(trips.id, id));
    }
    for (const id of createdDriverIds) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(drivers).where(eq(drivers.id, id));
    }
    for (const id of createdVehicleIds) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(vehicles).where(eq(vehicles.id, id));
    }
    for (const id of createdCarrierIds) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(carriers).where(eq(carriers.id, id));
    }
    for (const id of createdLocationIds) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(locations).where(eq(locations.id, id));
    }
    for (const id of createdCustomerIds) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(customers).where(eq(customers.id, id));
    }
  });

  it("assigns a received trip → assigned, one is_current row, assigned_by/at + notes, one trip.assign audit", async () => {
    const tripId = await insertTrip("received");
    const { trip, findings } = await assignTrip(
      tripId,
      fullInput({ notes: "Carga prioritária" }),
      actorId,
    );

    expect(trip.currentStatus).toBe("assigned");
    expect(findings).toHaveLength(0); // a clean (owned, matching, active, non-expired) pair WARNs nothing.

    // Exactly one current assignment row, with the chosen resources + actor + notes recorded.
    const current = await db
      .select()
      .from(tripAssignments)
      .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.isCurrent, true)));
    expect(current).toHaveLength(1);
    expect(current[0]!.driverId).toBe(driverId);
    expect(current[0]!.vehicleId).toBe(vehicleId);
    expect(current[0]!.assignedByUserId).toBe(actorId);
    expect(current[0]!.assignedAt).not.toBeNull();
    expect(current[0]!.notes).toBe("Carga prioritária");
    expect(current[0]!.overrideReason).toBeNull();

    // The returned detail mirrors the persisted current assignment.
    expect(trip.currentAssignment).not.toBeNull();
    expect(trip.currentAssignment!.id).toBe(current[0]!.id);
    expect(trip.assignmentHistory).toHaveLength(0);

    // Exactly one trip.assign audit + one status_change event.
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, tripId), eq(auditLogs.action, "trip.assign")));
    expect(audits).toHaveLength(1);

    const events = await db
      .select()
      .from(tripEvents)
      .where(and(eq(tripEvents.tripId, tripId), eq(tripEvents.eventType, "status_change")));
    expect(events).toHaveLength(1);
    expect(events[0]!.statusBefore).toBe("received");
    expect(events[0]!.statusAfter).toBe("assigned");
  });

  it("rejects a driver-only assignment with INCOMPLETE_ASSIGNMENT (vehicle required)", async () => {
    const tripId = await insertTrip("received");
    const driverOnly = { driverId, expectedFromStatus: "received" } as unknown as AssignTripInput;
    await expect(assignTrip(tripId, driverOnly, actorId)).rejects.toMatchObject({
      code: "INCOMPLETE_ASSIGNMENT",
    });
    await expect(assignTrip(tripId, driverOnly, actorId)).rejects.toBeInstanceOf(Conflict);
    // No state changed: the trip is untouched and no assignment row was written.
    const rows = await db.select().from(trips).where(eq(trips.id, tripId)).limit(1);
    expect(rows[0]!.currentStatus).toBe("received");
    const asg = await db.select().from(tripAssignments).where(eq(tripAssignments.tripId, tripId));
    expect(asg).toHaveLength(0);
  });

  it("rejects assigning a trip that is not received with STALE_TRANSITION", async () => {
    // slice 015: assign guards `WHERE current_status='received'`. Seed the trip ALREADY `assigned`
    // (a genuinely non-`received` status) so the guarded UPDATE matches 0 rows → STALE_TRANSITION.
    // (Before the collapse this case seeded `received` against a `validated` guard; `received` is now
    // the assignable source, so the stale source had to move off it.)
    const tripId = await insertTrip("assigned");
    await expect(assignTrip(tripId, fullInput(), actorId)).rejects.toMatchObject({
      code: "STALE_TRANSITION",
    });
    expect(
      (await db.select().from(trips).where(eq(trips.id, tripId)).limit(1))[0]!.currentStatus,
    ).toBe("assigned");
  });

  it("confirms an assigned trip → confirmed, sets confirmed_by/at, writes one trip.confirm audit", async () => {
    const tripId = await insertTrip("received");
    await assignTrip(tripId, fullInput(), actorId);

    const { trip } = await confirmTripAssignment(
      tripId,
      { expectedFromStatus: "assigned" },
      actorId,
    );
    expect(trip.currentStatus).toBe("confirmed");

    // The current assignment row carries confirmed_by/at; it is still the single is_current row.
    const current = await db
      .select()
      .from(tripAssignments)
      .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.isCurrent, true)));
    expect(current).toHaveLength(1);
    expect(current[0]!.confirmedByUserId).toBe(actorId);
    expect(current[0]!.confirmedAt).not.toBeNull();
    expect(trip.currentAssignment!.confirmedAt).not.toBeNull();

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, tripId), eq(auditLogs.action, "trip.confirm")));
    expect(audits).toHaveLength(1);

    // One assign + one confirm status_change event (assigned→confirmed).
    const confirmEvents = await db
      .select()
      .from(tripEvents)
      .where(and(eq(tripEvents.tripId, tripId), eq(tripEvents.eventType, "status_change")));
    const toConfirmed = confirmEvents.filter((e) => e.statusAfter === "confirmed");
    expect(toConfirmed).toHaveLength(1);
    expect(toConfirmed[0]!.statusBefore).toBe("assigned");
  });

  // T037 — the single-current-assignment integrity guard. A direct second is_current=true INSERT for
  // the same trip must violate the partial-unique index `trip_assignments_trip_active_uq` (SQLSTATE
  // 23505). We assert via the cause-chain walk because a DrizzleQueryError wraps the pg error.
  it("raises SQLSTATE 23505 on a second is_current=true insert for the same trip (partial-unique guard)", async () => {
    const tripId = await insertTrip("received");
    await assignTrip(tripId, fullInput(), actorId); // first current row (via the service).

    let caught: unknown;
    try {
      await db.insert(tripAssignments).values({
        tripId,
        driverId,
        vehicleId,
        assignedByUserId: actorId,
        isCurrent: true,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught, "a second is_current row must be rejected by the DB").toBeDefined();
    expect(findSqlState(caught)).toBe("23505");

    // The guard held: still exactly one current row.
    const current = await db
      .select()
      .from(tripAssignments)
      .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.isCurrent, true)));
    expect(current).toHaveLength(1);
  });
});
