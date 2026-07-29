import { test, expect, type APIRequestContext } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";
import {
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
import { testAccounts } from "./test-config";

/**
 * US4 (Reassign / substitute, retaining history) — feature 006, driven against the running app (T056).
 *
 * `POST /api/trips/:id/assignment` branches on `expectedFromStatus`: `received` ⇒ assign;
 * `assigned`/`confirmed` ⇒ reassign (supersede the current row, NO status change). After a reassign the
 * trip has EXACTLY ONE current assignment (the new resources) and the prior one is retained as
 * superseded history (`assignmentHistory`, with `supersededAt`). `DELETE …/assignment` un-assigns:
 * `assigned → received`, prior current row retained as history.
 *
 * Self-seeds OWNED, clean resources (so no findings interfere) + a `received` trip. FK-safe cleanup.
 */

const ADMIN_EMAIL = "admin@braziltransports.com.br";

function code(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}
function uniquePlate(): string {
  const letter = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `${letter()}${letter()}${letter()}${Math.floor(1000 + Math.random() * 9000)}`;
}
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
let driverA = "";
let driverB = "";
let vehicleA = "";
let vehicleB = "";
const tripIds: string[] = [];

async function seedReceivedTrip(): Promise<string> {
  const inserted = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId: code("EXT-REASSIGN"),
      originLocationId: originId,
      destinationLocationId: destId,
      currentStatus: "received",
      originalPlan: { customerId, originLocationId: originId, destinationLocationId: destId },
      plannedVehicleType: "truck",
      plannedPickupWindowStart: new Date("2026-10-01T08:00:00.000Z"),
      plannedDeliveryWindowEnd: new Date("2026-10-01T18:00:00.000Z"),
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
    .values({ name: "Cliente Reassign US4", customerCode: code("CUST") })
    .returning({ id: customers.id });
  customerId = cust[0]!.id;
  const origin = await db
    .insert(locations)
    .values({ customerId, code: code("ORIG"), name: "Origem Reassign" })
    .returning({ id: locations.id });
  originId = origin[0]!.id;
  const dest = await db
    .insert(locations)
    .values({ customerId, code: code("DEST"), name: "Destino Reassign" })
    .returning({ id: locations.id });
  destId = dest[0]!.id;

  const mkDriver = async (): Promise<string> => {
    const r = await db
      .insert(drivers)
      .values({
        name: `Motorista Reassign ${code("D")}`,
        ownershipType: "owned",
        status: "active",
        licenseExpiry: farFutureDate(),
      })
      .returning({ id: drivers.id });
    return r[0]!.id;
  };
  const mkVehicle = async (): Promise<string> => {
    const r = await db
      .insert(vehicles)
      .values({
        plate: uniquePlate(),
        vehicleType: "truck",
        ownershipType: "owned",
        status: "active",
        documentExpiry: farFutureDate(),
      })
      .returning({ id: vehicles.id });
    return r[0]!.id;
  };

  driverA = await mkDriver();
  driverB = await mkDriver();
  vehicleA = await mkVehicle();
  vehicleB = await mkVehicle();
});

test.afterAll(async () => {
  if (tripIds.length) {
    await db.delete(tripAssignments).where(inArray(tripAssignments.tripId, tripIds));
    await db.delete(tripEvents).where(inArray(tripEvents.tripId, tripIds));
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, tripIds));
    await db.delete(trips).where(inArray(trips.id, tripIds));
  }
  const driverIds = [driverA, driverB].filter(Boolean);
  const vehicleIds = [vehicleA, vehicleB].filter(Boolean);
  if (driverIds.length) await db.delete(drivers).where(inArray(drivers.id, driverIds));
  if (vehicleIds.length) await db.delete(vehicles).where(inArray(vehicles.id, vehicleIds));
  for (const id of [originId, destId]) {
    if (id) await db.delete(locations).where(eq(locations.id, id));
  }
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

test.describe("US4 — reassign supersedes + retains history; unassign returns to received", () => {
  test("assign then reassign → exactly one current (new), prior in the retained history chain", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const tripId = await seedReceivedTrip();

    // 1) Assign driver A + vehicle A (received → assigned).
    const assign = await ctx.post(`/api/trips/${tripId}/assignment`, {
      data: { driverId: driverA, vehicleId: vehicleA, expectedFromStatus: "received" },
    });
    expect(assign.status()).toBe(200);

    const afterAssign = await ctx.get(`/api/trips/${tripId}`);
    const a = (await afterAssign.json()) as {
      item: { currentAssignment: { id: string; driverId: string } | null; assignmentHistory: unknown[] };
    };
    const firstAssignmentId = a.item.currentAssignment!.id;
    expect(a.item.currentAssignment!.driverId).toBe(driverA);
    expect(a.item.assignmentHistory).toEqual([]);

    // 2) Reassign to driver B + vehicle B (expectedFromStatus=assigned ⇒ reassign path, no status change).
    const reassign = await ctx.post(`/api/trips/${tripId}/assignment`, {
      data: { driverId: driverB, vehicleId: vehicleB, expectedFromStatus: "assigned" },
    });
    expect(reassign.status()).toBe(200);

    const afterReassign = await ctx.get(`/api/trips/${tripId}`);
    const r = (await afterReassign.json()) as {
      item: {
        currentStatus: string;
        currentAssignment: { id: string; driverId: string; vehicleId: string; isCurrent: boolean } | null;
        assignmentHistory: Array<{ id: string; driverId: string; isCurrent: boolean; supersededAt: string | null }>;
        audit: Array<{ action: string }>;
      };
    };
    // Status is UNCHANGED by the substitution.
    expect(r.item.currentStatus).toBe("assigned");
    // Exactly one CURRENT assignment, and it is the NEW resources.
    expect(r.item.currentAssignment!.driverId).toBe(driverB);
    expect(r.item.currentAssignment!.vehicleId).toBe(vehicleB);
    expect(r.item.currentAssignment!.isCurrent).toBe(true);
    expect(r.item.currentAssignment!.id).not.toBe(firstAssignmentId);
    // The prior assignment is retained as superseded history (not deleted).
    expect(r.item.assignmentHistory.length).toBe(1);
    const prior = r.item.assignmentHistory[0]!;
    expect(prior.id).toBe(firstAssignmentId);
    expect(prior.driverId).toBe(driverA);
    expect(prior.isCurrent).toBe(false);
    expect(prior.supersededAt).toBeTruthy();
    // A reassign is audited as trip.reassign.
    expect(r.item.audit.some((x) => x.action === "trip.reassign")).toBe(true);
  });

  test("unassign an assigned trip → received, prior assignment retained as history", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const tripId = await seedReceivedTrip();

    const assign = await ctx.post(`/api/trips/${tripId}/assignment`, {
      data: { driverId: driverA, vehicleId: vehicleA, expectedFromStatus: "received" },
    });
    expect(assign.status()).toBe(200);

    const unassign = await ctx.delete(`/api/trips/${tripId}/assignment`, {
      data: { expectedFromStatus: "assigned" },
    });
    expect(unassign.status()).toBe(200);

    const detail = await ctx.get(`/api/trips/${tripId}`);
    const { item } = (await detail.json()) as {
      item: {
        currentStatus: string;
        currentAssignment: unknown;
        assignmentHistory: Array<{ driverId: string; isCurrent: boolean }>;
        audit: Array<{ action: string }>;
      };
    };
    expect(item.currentStatus).toBe("received");
    expect(item.currentAssignment).toBeNull();
    // The prior assignment is retained (superseded), never deleted.
    expect(item.assignmentHistory.length).toBe(1);
    expect(item.assignmentHistory[0]!.driverId).toBe(driverA);
    expect(item.assignmentHistory[0]!.isCurrent).toBe(false);
    expect(item.audit.some((x) => x.action === "trip.unassign")).toBe(true);
  });
});
