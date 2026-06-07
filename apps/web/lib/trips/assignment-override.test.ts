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
  users,
  vehicles,
} from "@brazil-tms/db";
import type { AssignTripInput, Finding, TripStatus } from "@brazil-tms/shared";

/**
 * Feature 006 — integration test for the WARN-override / BLOCK semantics (US3) of `assignTrip`. Static
 * imports per project convention; skips when DATABASE_URL is unset. To run it:
 *   $env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
 *   pnpm exec vitest run --project web apps/web/lib/trips/assignment-override.test.ts
 *
 * R7/R9: a WARN finding with NO override reason refuses with `OVERRIDE_REQUIRED` (the warn findings are
 * attached to `Conflict.details`); a BLOCK finding is ABSOLUTE — supplying an override reason still
 * refuses with `ASSIGNMENT_BLOCKED`; a WARN finding WITH a reason proceeds, persisting `override_reason`
 * on the assignment row and recording `reason` on the `trip.assign` audit.
 *
 * The WARN-only condition used here is a vehicle-type mismatch (van vs the trip's planned truck); the
 * BLOCK condition is a blocked driver. The suite seeds + cleans up ALL its own fixtures (FK-safe).
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("assignment-override (integration)", () => {
  let actorId = "";
  let customerId = "";
  let originLocationId = "";
  let destinationLocationId = "";
  // Clean active owned driver, a van (type-mismatch ⇒ WARN), and a blocked driver (⇒ BLOCK).
  let goodDriverId = "";
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

  // Distinct, non-overlapping windows so the reused fleet never triggers a stray schedule_overlap WARN.
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
        plannedVehicleType: "truck", // a van candidate ⇒ type_mismatch WARN.
        plannedPickupWindowStart: new Date(`2026-08-${day}T08:00:00.000Z`),
        plannedDeliveryWindowEnd: new Date(`2026-08-${day}T18:00:00.000Z`),
      })
      .returning();
    const id = inserted[0]!.id;
    createdTripIds.push(id);
    return id;
  }

  const input = (over: Partial<AssignTripInput>): AssignTripInput => ({
    driverId: goodDriverId,
    vehicleId: vanVehicleId,
    expectedFromStatus: "received",
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
      .values({ name: "Cliente Override", customerCode: code("CUST-OVR") })
      .returning();
    customerId = cust[0]!.id;
    createdCustomerIds.push(customerId);

    const origin = await db
      .insert(locations)
      .values({ customerId, code: code("ORIG"), name: "Origem Override" })
      .returning();
    originLocationId = origin[0]!.id;
    createdLocationIds.push(originLocationId);

    const dest = await db
      .insert(locations)
      .values({ customerId, code: code("DEST"), name: "Destino Override" })
      .returning();
    destinationLocationId = dest[0]!.id;
    createdLocationIds.push(destinationLocationId);

    const good = await db
      .insert(drivers)
      .values({ name: code("MotOk"), ownershipType: "owned", status: "active", licenseExpiry: "2030-01-01" })
      .returning();
    goodDriverId = good[0]!.id;
    createdDriverIds.push(goodDriverId);

    const blocked = await db
      .insert(drivers)
      .values({ name: code("MotBlk"), ownershipType: "owned", status: "blocked", licenseExpiry: "2030-01-01" })
      .returning();
    blockedDriverId = blocked[0]!.id;
    createdDriverIds.push(blockedDriverId);

    const van = await db
      .insert(vehicles)
      .values({
        plate: `OVR${Date.now().toString(36).slice(-6)}`,
        vehicleType: "van",
        ownershipType: "owned",
        status: "active",
        documentExpiry: "2030-01-01",
      })
      .returning();
    vanVehicleId = van[0]!.id;
    createdVehicleIds.push(vanVehicleId);
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

  it("refuses with OVERRIDE_REQUIRED (and attaches the warn findings) when a WARN has no reason", async () => {
    const tripId = await insertTrip("received");
    let caught: unknown;
    try {
      await assignTrip(tripId, input({}), actorId); // van vs truck ⇒ type_mismatch WARN, no reason.
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Conflict);
    expect((caught as Conflict).code).toBe("OVERRIDE_REQUIRED");

    // The conflicting WARN findings ride on Conflict.details so the BFF can return them.
    const details = (caught as Conflict).details as Finding[];
    expect(Array.isArray(details)).toBe(true);
    expect(details.some((f) => f.code === "type_mismatch" && f.severity === "warn")).toBe(true);
    expect(details.every((f) => f.severity === "warn")).toBe(true);

    // Refused ⇒ NO state change: trip still received, no assignment row.
    expect(
      (await db.select().from(trips).where(eq(trips.id, tripId)).limit(1))[0]!.currentStatus,
    ).toBe("received");
    expect(await db.select().from(tripAssignments).where(eq(tripAssignments.tripId, tripId))).toHaveLength(
      0,
    );
  });

  it("treats a BLOCK as absolute — an override reason does NOT bypass ASSIGNMENT_BLOCKED", async () => {
    const tripId = await insertTrip("received");
    let caught: unknown;
    try {
      await assignTrip(
        tripId,
        input({ driverId: blockedDriverId, overrideReason: "Cliente aprovou verbalmente" }),
        actorId,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Conflict);
    expect((caught as Conflict).code).toBe("ASSIGNMENT_BLOCKED");
    // The BLOCK findings are attached.
    const details = (caught as Conflict).details as Finding[];
    expect(details.some((f) => f.code === "driver_blocked" && f.severity === "block")).toBe(true);

    expect(
      (await db.select().from(trips).where(eq(trips.id, tripId)).limit(1))[0]!.currentStatus,
    ).toBe("received");
  });

  it("proceeds when a WARN is overridden with a reason — persists override_reason + audits the reason", async () => {
    const tripId = await insertTrip("received");
    const reason = "Veículo van aprovado pelo cliente para esta carga leve";
    const { trip, findings } = await assignTrip(tripId, input({ overrideReason: reason }), actorId);

    expect(trip.currentStatus).toBe("assigned");
    // The service returns the overridden WARN findings.
    expect(findings.some((f) => f.code === "type_mismatch")).toBe(true);

    // override_reason persisted on the current assignment row + surfaced on the detail.
    const current = await db
      .select()
      .from(tripAssignments)
      .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.isCurrent, true)));
    expect(current).toHaveLength(1);
    expect(current[0]!.overrideReason).toBe(reason);
    expect(trip.currentAssignment!.overrideReason).toBe(reason);

    // The trip.assign audit records the override reason.
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, tripId), eq(auditLogs.action, "trip.assign")));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.reason).toBe(reason);
  });
});
