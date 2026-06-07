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
 * US3 (Override a warning with a recorded reason) — feature 006, driven against the running app (T047).
 *
 * A WARN can be cleared only by supplying a non-empty `overrideReason`; the reason is persisted on the
 * assignment and recorded in the trip's audit history. Empty reason ⇒ refused (`OVERRIDE_REQUIRED`).
 * A non-`assign_resources` user (Finance) is refused `403` server-side regardless of body. A BLOCK is
 * NEVER overridable — even with a reason it stays `409 ASSIGNMENT_BLOCKED`.
 *
 * The WARN is constructed with a vehicle-type mismatch (van vs planned truck — `type_mismatch`, WARN);
 * the BLOCK with a maintenance vehicle (`vehicle_maintenance`, BLOCK). Self-seeds via `@brazil-tms/db`;
 * FK-safe cleanup; unique ids.
 */

const ADMIN_EMAIL = "admin@braziltransports.com.br";
const OVERRIDE_REASON = "Cliente autorizou o veículo substituto por telefone.";

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

interface Finding {
  severity: "block" | "warn";
  code: string;
}

let customerId = "";
let originId = "";
let destId = "";
let driverId = "";
let vanVehicleId = ""; // WARN: van vs planned truck
let maintenanceVehicleId = ""; // BLOCK: maintenance
const tripIds: string[] = [];

async function seedReceivedTrip(): Promise<string> {
  const inserted = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId: code("EXT-OVR"),
      originLocationId: originId,
      destinationLocationId: destId,
      currentStatus: "received",
      originalPlan: { customerId, originLocationId: originId, destinationLocationId: destId },
      plannedVehicleType: "truck",
      plannedPickupWindowStart: new Date("2026-09-01T08:00:00.000Z"),
      plannedDeliveryWindowEnd: new Date("2026-09-01T18:00:00.000Z"),
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
    .values({ name: "Cliente Override US3", customerCode: code("CUST") })
    .returning({ id: customers.id });
  customerId = cust[0]!.id;
  const origin = await db
    .insert(locations)
    .values({ customerId, code: code("ORIG"), name: "Origem Override" })
    .returning({ id: locations.id });
  originId = origin[0]!.id;
  const dest = await db
    .insert(locations)
    .values({ customerId, code: code("DEST"), name: "Destino Override" })
    .returning({ id: locations.id });
  destId = dest[0]!.id;

  const drv = await db
    .insert(drivers)
    .values({
      name: `Motorista Override ${code("D")}`,
      ownershipType: "owned",
      status: "active",
      licenseExpiry: farFutureDate(),
    })
    .returning({ id: drivers.id });
  driverId = drv[0]!.id;

  const van = await db
    .insert(vehicles)
    .values({
      plate: uniquePlate(),
      vehicleType: "van",
      ownershipType: "owned",
      status: "active",
      documentExpiry: farFutureDate(),
    })
    .returning({ id: vehicles.id });
  vanVehicleId = van[0]!.id;

  const maint = await db
    .insert(vehicles)
    .values({
      plate: uniquePlate(),
      vehicleType: "truck",
      ownershipType: "owned",
      status: "maintenance",
      documentExpiry: farFutureDate(),
    })
    .returning({ id: vehicles.id });
  maintenanceVehicleId = maint[0]!.id;
});

test.afterAll(async () => {
  if (tripIds.length) {
    await db.delete(tripAssignments).where(inArray(tripAssignments.tripId, tripIds));
    await db.delete(tripEvents).where(inArray(tripEvents.tripId, tripIds));
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, tripIds));
    await db.delete(trips).where(inArray(trips.id, tripIds));
  }
  if (driverId) await db.delete(drivers).where(eq(drivers.id, driverId));
  const vehicleIds = [vanVehicleId, maintenanceVehicleId].filter(Boolean);
  if (vehicleIds.length) await db.delete(vehicles).where(inArray(vehicles.id, vehicleIds));
  for (const id of [originId, destId]) {
    if (id) await db.delete(locations).where(eq(locations.id, id));
  }
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

test.describe("US3 — override a WARN with a recorded reason", () => {
  test("WARN with no override reason → 409 OVERRIDE_REQUIRED (findings returned)", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const tripId = await seedReceivedTrip();

    const res = await ctx.post(`/api/trips/${tripId}/assignment`, {
      data: { driverId, vehicleId: vanVehicleId, expectedFromStatus: "received" },
    });
    expect(res.status()).toBe(409);
    const body = (await res.json()) as { error: { code: string }; findings?: Finding[] };
    expect(body.error.code).toBe("OVERRIDE_REQUIRED");
    expect(body.findings && body.findings.some((f) => f.severity === "warn")).toBe(true);
  });

  test("WARN WITH a reason → 200, reason persisted on the assignment + recorded in audit", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const tripId = await seedReceivedTrip();

    const res = await ctx.post(`/api/trips/${tripId}/assignment`, {
      data: {
        driverId,
        vehicleId: vanVehicleId,
        expectedFromStatus: "received",
        overrideReason: OVERRIDE_REASON,
      },
    });
    expect(res.status()).toBe(200);
    const okBody = (await res.json()) as { item: { currentStatus: string } };
    expect(okBody.item.currentStatus).toBe("assigned");

    // The reason is persisted on the current assignment...
    const detail = await ctx.get(`/api/trips/${tripId}`);
    const { item } = (await detail.json()) as {
      item: {
        currentAssignment: { overrideReason: string | null } | null;
        audit: Array<{ action: string; reason: string | null }>;
      };
    };
    expect(item.currentAssignment!.overrideReason).toBe(OVERRIDE_REASON);
    // ...and recorded in the audit history (reason carried on the trip.assign row).
    const assignAudit = item.audit.find((a) => a.action === "trip.assign");
    expect(assignAudit, "trip.assign audit row").toBeTruthy();
    expect(assignAudit!.reason).toBe(OVERRIDE_REASON);
  });

  test("empty/whitespace override reason → rejected (Zod 400 at the boundary)", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const tripId = await seedReceivedTrip();

    // The schema trims + `min(1)` the reason, so a blank reason is a 400 — the override never reaches
    // the service. (A missing reason on a WARN is the 409 OVERRIDE_REQUIRED case above.)
    const res = await ctx.post(`/api/trips/${tripId}/assignment`, {
      data: {
        driverId,
        vehicleId: vanVehicleId,
        expectedFromStatus: "received",
        overrideReason: "   ",
      },
    });
    expect(res.status()).toBe(400);
  });

  test("Finance (no assign_resources) → 403 even with a valid override body", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.nonAdmin);
    const tripId = await seedReceivedTrip();

    const res = await ctx.post(`/api/trips/${tripId}/assignment`, {
      data: {
        driverId,
        vehicleId: vanVehicleId,
        expectedFromStatus: "received",
        overrideReason: OVERRIDE_REASON,
      },
    });
    expect(res.status()).toBe(403);

    // No state change: the trip is still received/unassigned.
    const ops = await apiLogin(request, testAccounts.opsManager);
    const detail = await ops.get(`/api/trips/${tripId}`);
    const { item } = (await detail.json()) as {
      item: { currentStatus: string; currentAssignment: unknown };
    };
    expect(item.currentStatus).toBe("received");
    expect(item.currentAssignment).toBeNull();
  });

  test("a BLOCK is never overridable, even with a reason → 409 ASSIGNMENT_BLOCKED", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const tripId = await seedReceivedTrip();

    const res = await ctx.post(`/api/trips/${tripId}/assignment`, {
      data: {
        driverId,
        vehicleId: maintenanceVehicleId,
        expectedFromStatus: "received",
        overrideReason: OVERRIDE_REASON,
      },
    });
    expect(res.status()).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ASSIGNMENT_BLOCKED");
  });
});
