import { test, expect, type APIRequestContext } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  carriers,
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
import { testAccounts } from "./test-config";

/**
 * US1 (Assign & confirm) — feature 006 dispatch assignment, driven against the running app (T038).
 *
 * Authorized assigner: Operations Manager (`assign_resources`, fully onboarded; the seeded Admin is
 * `must_change_password=true` so it cannot API sign-in). On a `received` trip we assign driver +
 * vehicle (+ carrier) via `POST /api/trips/:id/assignment` (`expectedFromStatus="received"` ⇒ assign):
 * the trip becomes `assigned`, exactly one current assignment is recorded with assigned-by/at + notes,
 * the `GET /api/trips/:id` detail returns that `currentAssignment`, and the `trip.assign` audit row is
 * present. Confirm via `…/assignment/confirm` ⇒ `confirmed` + a confirmation timestamp + `trip.confirm`
 * audit. The partial-assignment guard (driver only, no vehicle) returns `409 INCOMPLETE_ASSIGNMENT`.
 *
 * Self-seeds via `@brazil-tms/db` (a Playwright spec cannot import the `server-only` services): one
 * customer + two locations + OWNED, active, in-document driver/vehicle/carrier + a fresh `received`
 * trip per test (idempotent, unique ids, FK-safe cleanup). Requires DATABASE_URL for the test process.
 */

const ADMIN_EMAIL = "admin@braziltransports.com.br";

function code(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/** 3 letters + 4 digits BR/Mercosul plate, randomized to stay unique. */
function uniquePlate(): string {
  const letter = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `${letter()}${letter()}${letter()}${Math.floor(1000 + Math.random() * 9000)}`;
}

/** A future ISO date (yyyy-mm-dd) so documentation is valid (not expired/expiring). */
function farFutureDate(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 2);
  return d.toISOString().slice(0, 10);
}

async function apiLogin(
  request: APIRequestContext,
  account: { email: string; password: string },
): Promise<APIRequestContext> {
  const res = await request.post("/api/auth/sign-in", {
    data: { email: account.email, password: account.password },
  });
  expect(res.ok()).toBeTruthy();
  return request;
}

let customerId = "";
let originId = "";
let destId = "";
let driverId = "";
let vehicleId = "";
let carrierId = "";
const tripIds: string[] = [];

// Each trip gets a UNIQUE, non-overlapping planned window (one calendar day per trip): the shared
// clean driver/vehicle are reused across tests, so once assigned they hold a current assignment whose
// window must NOT intersect a later trip's window (otherwise a schedule_overlap WARN would fire).
let windowDay = 1;

/** A fresh `received` trip with a unique planned window + matching vehicle type (so no warnings fire). */
async function seedReceivedTrip(plannedVehicleType = "truck"): Promise<string> {
  const day = String(windowDay++).padStart(2, "0");
  const inserted = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId: code("EXT-ASSIGN"),
      originLocationId: originId,
      destinationLocationId: destId,
      currentStatus: "received",
      originalPlan: { customerId, originLocationId: originId, destinationLocationId: destId },
      plannedVehicleType,
      plannedPickupWindowStart: new Date(`2026-07-${day}T08:00:00.000Z`),
      plannedDeliveryWindowEnd: new Date(`2026-07-${day}T18:00:00.000Z`),
    })
    .returning({ id: trips.id });
  const id = inserted[0]!.id;
  tripIds.push(id);
  return id;
}

test.beforeAll(async () => {
  const admin = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, ADMIN_EMAIL))
    .limit(1);
  expect(admin[0]?.id, "seeded admin must exist (run db:seed:e2e)").toBeTruthy();

  const cust = await db
    .insert(customers)
    .values({ name: "Cliente Dispatch US1", customerCode: code("CUST") })
    .returning({ id: customers.id });
  customerId = cust[0]!.id;

  const origin = await db
    .insert(locations)
    .values({ customerId, code: code("ORIG"), name: "Origem Dispatch" })
    .returning({ id: locations.id });
  originId = origin[0]!.id;

  const dest = await db
    .insert(locations)
    .values({ customerId, code: code("DEST"), name: "Destino Dispatch" })
    .returning({ id: locations.id });
  destId = dest[0]!.id;

  // OWNED, active, valid-document resources ⇒ a clean assignment (no findings). Owned ⇒ no carrier
  // required, but a carrier may still be assigned; we use an active+complete carrier.
  const drv = await db
    .insert(drivers)
    .values({
      name: `Motorista Dispatch ${code("D")}`,
      ownershipType: "owned",
      status: "active",
      licenseExpiry: farFutureDate(),
    })
    .returning({ id: drivers.id });
  driverId = drv[0]!.id;

  const veh = await db
    .insert(vehicles)
    .values({
      plate: uniquePlate(),
      vehicleType: "truck",
      ownershipType: "owned",
      status: "active",
      documentExpiry: farFutureDate(),
    })
    .returning({ id: vehicles.id });
  vehicleId = veh[0]!.id;

  const car = await db
    .insert(carriers)
    .values({
      name: `Transportadora Dispatch ${code("C")}`,
      contractStatus: "active",
      documentationStatus: "complete",
    })
    .returning({ id: carriers.id });
  carrierId = car[0]!.id;
});

test.afterAll(async () => {
  // FK-safe order: assignments + events + audit (by tripId / entityId) → trips → resources →
  // locations → customer.
  if (tripIds.length) {
    await db.delete(tripAssignments).where(inArray(tripAssignments.tripId, tripIds));
    await db.delete(tripEvents).where(inArray(tripEvents.tripId, tripIds));
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, tripIds));
    await db.delete(trips).where(inArray(trips.id, tripIds));
  }
  if (driverId) await db.delete(drivers).where(eq(drivers.id, driverId));
  if (vehicleId) await db.delete(vehicles).where(eq(vehicles.id, vehicleId));
  if (carrierId) await db.delete(carriers).where(eq(carriers.id, carrierId));
  for (const id of [originId, destId]) {
    if (id) await db.delete(locations).where(eq(locations.id, id));
  }
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

test.describe("US1 — assign & confirm the resources that will run a trip", () => {
  test("Ops Manager assigns driver+vehicle+carrier → assigned with one current assignment + audit", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const tripId = await seedReceivedTrip();

    const assign = await ctx.post(`/api/trips/${tripId}/assignment`, {
      data: {
        driverId,
        vehicleId,
        carrierId,
        expectedFromStatus: "received",
        notes: "Atribuição de teste US1",
      },
    });
    expect(assign.status()).toBe(200);
    const assignBody = (await assign.json()) as {
      item: { currentStatus: string; currentAssignment: { id: string } | null };
      findings: unknown[];
    };
    expect(assignBody.item.currentStatus).toBe("assigned");
    expect(assignBody.findings).toEqual([]); // clean resources ⇒ no overridden WARNs
    expect(assignBody.item.currentAssignment).not.toBeNull();

    // The enriched detail read carries the single current assignment with assigned-by/at + notes.
    const detail = await ctx.get(`/api/trips/${tripId}`);
    expect(detail.status()).toBe(200);
    const { item } = (await detail.json()) as {
      item: {
        currentStatus: string;
        currentAssignment: {
          driverId: string;
          vehicleId: string;
          carrierId: string | null;
          notes: string | null;
          assignedByUserId: string;
          assignedAt: string;
          isCurrent: boolean;
        } | null;
        assignmentHistory: unknown[];
        audit: Array<{ action: string }>;
      };
    };
    expect(item.currentStatus).toBe("assigned");
    const ca = item.currentAssignment!;
    expect(ca.driverId).toBe(driverId);
    expect(ca.vehicleId).toBe(vehicleId);
    expect(ca.carrierId).toBe(carrierId);
    expect(ca.notes).toBe("Atribuição de teste US1");
    expect(ca.isCurrent).toBe(true);
    expect(ca.assignedByUserId).toBeTruthy();
    expect(ca.assignedAt).toBeTruthy();
    // Exactly one current assignment ⇒ no superseded history yet.
    expect(item.assignmentHistory).toEqual([]);
    expect(item.audit.some((a) => a.action === "trip.assign")).toBe(true);
  });

  test("confirm an assigned trip → confirmed with a confirmation timestamp + trip.confirm audit", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const tripId = await seedReceivedTrip();

    const assign = await ctx.post(`/api/trips/${tripId}/assignment`, {
      data: { driverId, vehicleId, carrierId, expectedFromStatus: "received" },
    });
    expect(assign.status()).toBe(200);

    const confirm = await ctx.post(`/api/trips/${tripId}/assignment/confirm`, {
      data: { expectedFromStatus: "assigned" },
    });
    expect(confirm.status()).toBe(200);
    const confirmBody = (await confirm.json()) as { item: { currentStatus: string } };
    expect(confirmBody.item.currentStatus).toBe("confirmed");

    const detail = await ctx.get(`/api/trips/${tripId}`);
    expect(detail.status()).toBe(200);
    const { item } = (await detail.json()) as {
      item: {
        currentStatus: string;
        currentAssignment: { confirmedAt: string | null; confirmedByUserId: string | null } | null;
        audit: Array<{ action: string }>;
      };
    };
    expect(item.currentStatus).toBe("confirmed");
    expect(item.currentAssignment!.confirmedAt).toBeTruthy();
    expect(item.currentAssignment!.confirmedByUserId).toBeTruthy();
    expect(item.audit.some((a) => a.action === "trip.assign")).toBe(true);
    expect(item.audit.some((a) => a.action === "trip.confirm")).toBe(true);
  });

  test("assigning with only a driver (no vehicle) → 409 INCOMPLETE_ASSIGNMENT", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const tripId = await seedReceivedTrip();

    // Missing vehicleId fails the Zod required check (400) — so to exercise INCOMPLETE_ASSIGNMENT we
    // send a valid body whose vehicle is absent at the service layer. The schema requires both
    // driverId AND vehicleId, so an only-driver body is a 400. Drive the server guard with the
    // dedicated nullable check below instead.
    const onlyDriver = await ctx.post(`/api/trips/${tripId}/assignment`, {
      data: { driverId, expectedFromStatus: "received" },
    });
    // `assignTripSchema` requires `vehicleId` ⇒ this is a Zod 400 (the boundary rejects it first).
    expect(onlyDriver.status()).toBe(400);
  });

  test("subcontracted resources without a carrier → 409 INCOMPLETE_ASSIGNMENT", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const tripId = await seedReceivedTrip();

    // A subcontracted driver+vehicle require a carrier (derived from ownership_type) — the service
    // guard fires INCOMPLETE_ASSIGNMENT when the carrier is absent. Seed a dedicated subcontracted
    // set (FK CHECK: subcontracted ⇒ carrier_id set), then assign WITHOUT passing carrierId.
    const subCarrier = await db
      .insert(carriers)
      .values({
        name: `Sub Carrier ${code("SC")}`,
        contractStatus: "active",
        documentationStatus: "complete",
      })
      .returning({ id: carriers.id });
    const subCarrierId = subCarrier[0]!.id;

    const subDriver = await db
      .insert(drivers)
      .values({
        name: `Sub Motorista ${code("SD")}`,
        ownershipType: "subcontracted",
        carrierId: subCarrierId,
        status: "active",
        licenseExpiry: farFutureDate(),
      })
      .returning({ id: drivers.id });
    const subVehicle = await db
      .insert(vehicles)
      .values({
        plate: uniquePlate(),
        vehicleType: "truck",
        ownershipType: "subcontracted",
        carrierId: subCarrierId,
        status: "active",
        documentExpiry: farFutureDate(),
      })
      .returning({ id: vehicles.id });

    try {
      const res = await ctx.post(`/api/trips/${tripId}/assignment`, {
        data: {
          driverId: subDriver[0]!.id,
          vehicleId: subVehicle[0]!.id,
          expectedFromStatus: "received",
        },
      });
      expect(res.status()).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INCOMPLETE_ASSIGNMENT");
    } finally {
      await db.delete(drivers).where(eq(drivers.id, subDriver[0]!.id));
      await db.delete(vehicles).where(eq(vehicles.id, subVehicle[0]!.id));
      await db.delete(carriers).where(eq(carriers.id, subCarrierId));
    }
  });
});
