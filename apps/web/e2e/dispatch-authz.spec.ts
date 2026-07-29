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
 * Authorization matrix for the 006 dispatch write surface (T072; permission-matrix.md test focus).
 *
 * 006 first-enforces the pre-declared `assign_resources` key. An `assign_resources` holder (Operations
 * Manager / Dispatcher) can assign (`200`); a non-holder (Finance) is refused `403` server-side on
 * EVERY write (assign / reassign / unassign / confirm / dry-run check) even with a valid body; and a
 * view-only role (Finance holds `view_all_trips`) still READS the assignment-bearing endpoints
 * (`GET /api/trips`, `/api/trips/:id`, `/api/dashboard/summary` → `200`).
 *
 * The e2e seed provisions no Control Tower / Executive Viewer account, so Finance is the available
 * view-only-but-not-assign role (mirrors trips-control-tower.spec.ts using Finance for the read re-gate).
 *
 * Self-seeds OWNED clean resources + `received` trips. FK-safe cleanup; unique ids.
 */

const ADMIN_EMAIL = "admin@braziltransports.com.br";
const SOME_UUID = "00000000-0000-0000-0000-000000000000";

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
let driverId = "";
let vehicleId = "";
const tripIds: string[] = [];

// Unique, non-overlapping window per trip — the shared clean driver/vehicle are reused across the
// 200-on-assign tests, so a later trip must not intersect an earlier (now-assigned) one's window.
let windowDay = 1;

async function seedReceivedTrip(): Promise<string> {
  const day = String(windowDay++).padStart(2, "0");
  const inserted = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId: code("EXT-AUTHZ"),
      originLocationId: originId,
      destinationLocationId: destId,
      currentStatus: "received",
      originalPlan: { customerId, originLocationId: originId, destinationLocationId: destId },
      plannedVehicleType: "truck",
      plannedPickupWindowStart: new Date(`2026-11-${day}T08:00:00.000Z`),
      plannedDeliveryWindowEnd: new Date(`2026-11-${day}T18:00:00.000Z`),
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
    .values({ name: "Cliente Authz 006", customerCode: code("CUST") })
    .returning({ id: customers.id });
  customerId = cust[0]!.id;
  const origin = await db
    .insert(locations)
    .values({ customerId, code: code("ORIG"), name: "Origem Authz" })
    .returning({ id: locations.id });
  originId = origin[0]!.id;
  const dest = await db
    .insert(locations)
    .values({ customerId, code: code("DEST"), name: "Destino Authz" })
    .returning({ id: locations.id });
  destId = dest[0]!.id;

  const drv = await db
    .insert(drivers)
    .values({
      name: `Motorista Authz ${code("D")}`,
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
});

test.afterAll(async () => {
  if (tripIds.length) {
    await db.delete(tripAssignments).where(inArray(tripAssignments.tripId, tripIds));
    await db.delete(tripEvents).where(inArray(tripEvents.tripId, tripIds));
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, tripIds));
    await db.delete(trips).where(inArray(trips.id, tripIds));
  }
  if (driverId) await db.delete(drivers).where(eq(drivers.id, driverId));
  if (vehicleId) await db.delete(vehicles).where(eq(vehicles.id, vehicleId));
  for (const id of [originId, destId]) {
    if (id) await db.delete(locations).where(eq(locations.id, id));
  }
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

test.describe("006 authz — assign_resources holders may write", () => {
  test("no session → assign is 401", async ({ request }) => {
    const tripId = await seedReceivedTrip();
    const res = await request.post(`/api/trips/${tripId}/assignment`, {
      data: { driverId, vehicleId, expectedFromStatus: "received" },
    });
    expect(res.status()).toBe(401);
  });

  test("Operations Manager (assign_resources) → 200 on assign", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const tripId = await seedReceivedTrip();
    const res = await ctx.post(`/api/trips/${tripId}/assignment`, {
      data: { driverId, vehicleId, expectedFromStatus: "received" },
    });
    expect(res.status()).toBe(200);
  });

  test("Dispatcher (assign_resources) → 200 on assign", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.dispatcher);
    const tripId = await seedReceivedTrip();
    const res = await ctx.post(`/api/trips/${tripId}/assignment`, {
      data: { driverId, vehicleId, expectedFromStatus: "received" },
    });
    expect(res.status()).toBe(200);
  });
});

test.describe("006 authz — Finance (no assign_resources) is 403 on every write", () => {
  test("assign / reassign (POST), unassign (DELETE), confirm, dry-run check → all 403", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.nonAdmin);
    const tripId = await seedReceivedTrip();
    const validBody = { driverId, vehicleId, expectedFromStatus: "received" };

    // POST (assign OR reassign — both gated `assign_resources`).
    expect((await ctx.post(`/api/trips/${tripId}/assignment`, { data: validBody })).status()).toBe(
      403,
    );
    // DELETE (unassign).
    expect(
      (
        await ctx.delete(`/api/trips/${tripId}/assignment`, {
          data: { expectedFromStatus: "assigned" },
        })
      ).status(),
    ).toBe(403);
    // confirm.
    expect(
      (
        await ctx.post(`/api/trips/${tripId}/assignment/confirm`, {
          data: { expectedFromStatus: "assigned" },
        })
      ).status(),
    ).toBe(403);
    // dry-run check (also gated `assign_resources`).
    expect(
      (await ctx.post(`/api/trips/${tripId}/assignment/check`, { data: { driverId, vehicleId } })).status(),
    ).toBe(403);

    // Authorization is checked before any mutation → no state change (the trip stays received/unassigned).
    const ops = await apiLogin(request, testAccounts.opsManager);
    const detail = await ops.get(`/api/trips/${tripId}`);
    const { item } = (await detail.json()) as {
      item: { currentStatus: string; currentAssignment: unknown };
    };
    expect(item.currentStatus).toBe("received");
    expect(item.currentAssignment).toBeNull();
  });
});

test.describe("006 authz — a view-only role still reads assignment data via view_all_trips", () => {
  test("Finance → GET board / detail / dashboard summary all 200", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.nonAdmin);
    const tripId = await seedReceivedTrip();

    const board = await ctx.get("/api/trips");
    expect(board.status()).toBe(200);

    const detail = await ctx.get(`/api/trips/${tripId}`);
    expect(detail.status()).toBe(200);
    // The detail carries the (currently null) assignment projection 006 adds — readable under view_all_trips.
    const { item } = (await detail.json()) as {
      item: { currentAssignment: unknown; assignmentHistory: unknown[] };
    };
    expect(item.currentAssignment).toBeNull();
    expect(Array.isArray(item.assignmentHistory)).toBe(true);

    const summary = await ctx.get("/api/dashboard/summary");
    expect(summary.status()).toBe(200);
    const { summary: s } = (await summary.json()) as { summary: { unassignedTrips: number | null } };
    // 006 fills the previously-null unassigned count with a number.
    expect(typeof s.unassignedTrips).toBe("number");
  });

  test("an unknown trip id reads 404 (not 403) for a view_all_trips holder", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.nonAdmin);
    const res = await ctx.get(`/api/trips/${SOME_UUID}`);
    expect(res.status()).toBe(404);
  });
});
