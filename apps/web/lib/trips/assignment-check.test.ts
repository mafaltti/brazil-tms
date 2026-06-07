import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  carriers,
  checkAssignment,
  customers,
  db,
  drivers,
  gatherEligibilityContext,
  locations,
  tripAssignments,
  trailers,
  trips,
  users,
  vehicles,
} from "@brazil-tms/db";
import type { Finding, TripStatus } from "@brazil-tms/shared";

/**
 * Feature 006 — integration test for the read-only eligibility surface (US2): `gatherEligibilityContext`
 * (the schedule-overlap query) and `checkAssignment` (the dry-run that surfaces every PRD §19.2 check
 * at its policy-resolved severity). Static imports per project convention; skips when DATABASE_URL is
 * unset. To run it:
 *   $env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
 *   pnpm exec vitest run --project web apps/web/lib/trips/assignment-check.test.ts
 *
 * Severity map under test (data-model §3.2): resource_status (blocked/maintenance) = BLOCK; carrier
 * contract suspended/expired & doc expired = BLOCK; documentation expired = BLOCK, missing = WARN;
 * vehicle_type mismatch = WARN; schedule_overlap = WARN.
 *
 * The suite seeds + cleans up ALL its own fixtures (FK-safe).
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("assignment-check (integration)", () => {
  let actorId = "";
  let customerId = "";
  let originLocationId = "";
  let destinationLocationId = "";

  const createdTripIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdVehicleIds: string[] = [];
  const createdTrailerIds: string[] = [];
  const createdCarrierIds: string[] = [];
  const createdLocationIds: string[] = [];
  const createdCustomerIds: string[] = [];

  // The "target" trip every check runs against: planned `truck`, July-15 daytime window.
  let targetTripId = "";
  const TARGET_START = new Date("2026-07-15T08:00:00.000Z");
  const TARGET_END = new Date("2026-07-15T18:00:00.000Z");

  function code(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
  // Globally-unique plate: a per-suite token + a monotonic counter (plate is UNIQUE; truncating the
  // timestamp would collide for vehicles created in the same millisecond).
  const plateToken = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.slice(-7);
  let plateSeq = 0;
  function plate(): string {
    return `P${plateToken}${(plateSeq++).toString().padStart(3, "0")}`;
  }

  async function insertTrip(
    currentStatus: TripStatus,
    start: Date | null,
    end: Date | null,
    plannedVehicleType: "truck" | null = "truck",
  ): Promise<string> {
    const inserted = await db
      .insert(trips)
      .values({
        customerId,
        originLocationId,
        destinationLocationId,
        originalPlan: {},
        currentStatus,
        plannedVehicleType,
        plannedPickupWindowStart: start,
        plannedDeliveryWindowEnd: end,
      })
      .returning();
    const id = inserted[0]!.id;
    createdTripIds.push(id);
    return id;
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
      .values({ name: "Cliente Elegibilidade", customerCode: code("CUST-ELG") })
      .returning();
    customerId = cust[0]!.id;
    createdCustomerIds.push(customerId);

    const origin = await db
      .insert(locations)
      .values({ customerId, code: code("ORIG"), name: "Origem Elegibilidade" })
      .returning();
    originLocationId = origin[0]!.id;
    createdLocationIds.push(originLocationId);

    const dest = await db
      .insert(locations)
      .values({ customerId, code: code("DEST"), name: "Destino Elegibilidade" })
      .returning();
    destinationLocationId = dest[0]!.id;
    createdLocationIds.push(destinationLocationId);

    targetTripId = await insertTrip("received", TARGET_START, TARGET_END);
  });

  afterAll(async () => {
    for (const id of createdTripIds) {
      await db.delete(tripAssignments).where(eq(tripAssignments.tripId, id));
    }
    for (const id of createdTripIds) {
      await db.delete(trips).where(eq(trips.id, id));
    }
    for (const id of createdDriverIds) await db.delete(drivers).where(eq(drivers.id, id));
    for (const id of createdVehicleIds) await db.delete(vehicles).where(eq(vehicles.id, id));
    for (const id of createdTrailerIds) await db.delete(trailers).where(eq(trailers.id, id));
    for (const id of createdCarrierIds) await db.delete(carriers).where(eq(carriers.id, id));
    for (const id of createdLocationIds) await db.delete(locations).where(eq(locations.id, id));
    for (const id of createdCustomerIds) await db.delete(customers).where(eq(customers.id, id));
  });

  // --- Resource factories (each returns the new id; far-future docs unless stated). ---
  async function makeDriver(over: Partial<typeof drivers.$inferInsert> = {}): Promise<string> {
    const r = await db
      .insert(drivers)
      .values({
        name: code("Mot"),
        ownershipType: "owned",
        status: "active",
        licenseExpiry: "2030-01-01",
        ...over,
      })
      .returning();
    createdDriverIds.push(r[0]!.id);
    return r[0]!.id;
  }
  async function makeVehicle(over: Partial<typeof vehicles.$inferInsert> = {}): Promise<string> {
    const r = await db
      .insert(vehicles)
      .values({
        plate: plate(),
        vehicleType: "truck",
        ownershipType: "owned",
        status: "active",
        documentExpiry: "2030-01-01",
        ...over,
      })
      .returning();
    createdVehicleIds.push(r[0]!.id);
    return r[0]!.id;
  }
  async function makeCarrier(over: Partial<typeof carriers.$inferInsert> = {}): Promise<string> {
    const r = await db
      .insert(carriers)
      .values({ name: code("Transp"), contractStatus: "active", documentationStatus: "complete", ...over })
      .returning();
    createdCarrierIds.push(r[0]!.id);
    return r[0]!.id;
  }

  const has = (findings: Finding[], code: string, severity: "block" | "warn"): boolean =>
    findings.some((f) => f.code === code && f.severity === severity);

  // -------------------------------------------------------------------------
  // gatherEligibilityContext — the schedule-overlap query
  // -------------------------------------------------------------------------

  it("gatherEligibilityContext reports an overlap for a current assignment intersecting the trip window", async () => {
    const driverId = await makeDriver();
    const vehicleId = await makeVehicle();

    // A separate ACTIVE trip whose window overlaps the target's, with a CURRENT assignment on the
    // same driver+vehicle → an overlap entry per resource kind.
    const busyTripId = await insertTrip(
      "assigned",
      new Date("2026-07-15T12:00:00.000Z"),
      new Date("2026-07-16T02:00:00.000Z"),
    );
    await db.insert(tripAssignments).values({
      tripId: busyTripId,
      driverId,
      vehicleId,
      assignedByUserId: actorId,
      isCurrent: true,
    });

    const { context } = await gatherEligibilityContext(db, targetTripId, { driverId, vehicleId });
    const kinds = context.overlaps.map((o) => o.resourceKind).sort();
    expect(kinds).toEqual(["driver", "vehicle"]);
    expect(context.overlaps.every((o) => o.resourceId === driverId || o.resourceId === vehicleId)).toBe(
      true,
    );
  });

  it("gatherEligibilityContext EXCLUDES cancelled/terminal trips and non-overlapping windows", async () => {
    const driverId = await makeDriver();
    const vehicleId = await makeVehicle();

    // (a) a CANCELLED trip whose window overlaps → must NOT count (terminal trips never conflict).
    const cancelledTripId = await insertTrip(
      "cancelled",
      new Date("2026-07-15T10:00:00.000Z"),
      new Date("2026-07-15T20:00:00.000Z"),
    );
    await db.insert(tripAssignments).values({
      tripId: cancelledTripId,
      driverId,
      vehicleId,
      assignedByUserId: actorId,
      isCurrent: true,
    });

    // (b) an ACTIVE trip whose window does NOT overlap (a different day) → must NOT count.
    const laterTripId = await insertTrip(
      "assigned",
      new Date("2026-07-20T08:00:00.000Z"),
      new Date("2026-07-20T18:00:00.000Z"),
    );
    await db.insert(tripAssignments).values({
      tripId: laterTripId,
      driverId,
      vehicleId,
      assignedByUserId: actorId,
      isCurrent: true,
    });

    const { context } = await gatherEligibilityContext(db, targetTripId, { driverId, vehicleId });
    expect(context.overlaps).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // checkAssignment — each §19.2 check at the correct severity
  // -------------------------------------------------------------------------

  it("surfaces schedule_conflict as WARN when the resource has an overlapping current assignment", async () => {
    const driverId = await makeDriver();
    const vehicleId = await makeVehicle();
    const busyTripId = await insertTrip(
      "assigned",
      new Date("2026-07-15T09:00:00.000Z"),
      new Date("2026-07-15T15:00:00.000Z"),
    );
    await db.insert(tripAssignments).values({
      tripId: busyTripId,
      driverId,
      assignedByUserId: actorId,
      isCurrent: true,
    });

    const findings = await checkAssignment(targetTripId, { driverId, vehicleId });
    expect(has(findings, "schedule_overlap", "warn")).toBe(true);
    expect(findings.find((f) => f.code === "schedule_overlap")!.check).toBe("schedule_conflict");
  });

  it("surfaces resource_status as BLOCK for a blocked driver and a vehicle in maintenance", async () => {
    const driverId = await makeDriver({ status: "blocked" });
    const vehicleId = await makeVehicle({ status: "maintenance" });

    const findings = await checkAssignment(targetTripId, { driverId, vehicleId });
    expect(has(findings, "driver_blocked", "block")).toBe(true);
    expect(has(findings, "vehicle_maintenance", "block")).toBe(true);
    expect(
      findings.filter((f) => f.check === "resource_status").every((f) => f.severity === "block"),
    ).toBe(true);
  });

  it("surfaces vehicle_type as WARN when the vehicle type does not match the trip's planned type", async () => {
    const driverId = await makeDriver();
    const vehicleId = await makeVehicle({ vehicleType: "van" }); // trip planned `truck`.

    const findings = await checkAssignment(targetTripId, { driverId, vehicleId });
    expect(has(findings, "type_mismatch", "warn")).toBe(true);
    expect(findings.find((f) => f.code === "type_mismatch")!.check).toBe("vehicle_type");
  });

  it("surfaces carrier_eligibility as BLOCK for a suspended carrier", async () => {
    const driverId = await makeDriver();
    const vehicleId = await makeVehicle();
    const carrierId = await makeCarrier({ contractStatus: "suspended" });

    const findings = await checkAssignment(targetTripId, { driverId, vehicleId, carrierId });
    // A non-active, non-expired contract status maps to carrier_inactive (BLOCK).
    expect(has(findings, "carrier_inactive", "block")).toBe(true);
    expect(findings.find((f) => f.code === "carrier_inactive")!.check).toBe("carrier_eligibility");
  });

  it("surfaces documentation as BLOCK when a license is expired and WARN when it is missing", async () => {
    // Expired driver license (yesterday) → doc_expired BLOCK.
    const expiredDriverId = await makeDriver({ licenseExpiry: "2020-01-01" });
    const vehicleId = await makeVehicle();
    const expiredFindings = await checkAssignment(targetTripId, {
      driverId: expiredDriverId,
      vehicleId,
    });
    expect(has(expiredFindings, "doc_expired", "block")).toBe(true);
    expect(expiredFindings.find((f) => f.code === "doc_expired")!.check).toBe("documentation");

    // Missing driver license (null) → doc_missing WARN.
    const missingDriverId = await makeDriver({ licenseExpiry: null });
    const vehicle2Id = await makeVehicle();
    const missingFindings = await checkAssignment(targetTripId, {
      driverId: missingDriverId,
      vehicleId: vehicle2Id,
    });
    expect(has(missingFindings, "doc_missing", "warn")).toBe(true);
  });

  it("surfaces *_archived as BLOCK for an archived (soft-deleted) driver/vehicle, independent of status", async () => {
    // Archived but still status `active` — the UI picker hides it (isNull(archived_at)), but a direct
    // API caller must be refused server-side (the evaluator owns authority).
    const driverId = await makeDriver({ archivedAt: new Date() });
    const vehicleId = await makeVehicle({ archivedAt: new Date() });

    const findings = await checkAssignment(targetTripId, { driverId, vehicleId });
    expect(has(findings, "driver_archived", "block")).toBe(true);
    expect(has(findings, "vehicle_archived", "block")).toBe(true);
    expect(findings.find((f) => f.code === "driver_archived")!.check).toBe("resource_status");
  });
});
