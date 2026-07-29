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
 * US2 (Conflict & eligibility warnings) — feature 006, driven against the running app (T044).
 *
 * The warnings are SERVER-AUTHORITATIVE (STACK §6.1): the UI only displays the findings the BFF
 * computes. We exercise the dry-run `POST /api/trips/:id/assignment/check` (the exact endpoint the
 * inline panel/board call) to construct each §19.2 finding and assert its severity, then prove a BLOCK
 * combination posted DIRECTLY to `POST /api/trips/:id/assignment` (UI bypassed) is still refused
 * `409 ASSIGNMENT_BLOCKED` with the offending findings — the UI does not own conflict authority.
 *
 * Severity map (DEFAULT_ASSIGNMENT_POLICY): vehicle `maintenance`/`blocked` & expired docs & carrier
 * contract-expired = BLOCK; schedule overlap, vehicle-type mismatch & missing docs = WARN.
 *
 * Self-seeds via `@brazil-tms/db`: one customer + locations + a spread of resources with deliberately
 * problematic states, plus `received` trips with planned windows. FK-safe cleanup; unique ids.
 */

const ADMIN_EMAIL = "admin@braziltransports.com.br";

function code(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function uniquePlate(): string {
  const letter = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `${letter()}${letter()}${letter()}${Math.floor(1000 + Math.random() * 9000)}`;
}

function isoDateOffsetDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function farFutureDate(): string {
  return isoDateOffsetDays(730);
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
  check: string;
  resourceKind: string;
  resourceId: string;
  severity: "block" | "warn";
  code: string;
}

let customerId = "";
let originId = "";
let destId = "";

// Reusable clean resources (active, valid docs, owned) — NEVER pre-assigned, so they never overlap.
let cleanDriverId = "";
let cleanVehicleId = "";
// A SEPARATE clean pair dedicated to the schedule-overlap construction (held on overlapTripA).
let overlapDriverId = "";
let overlapVehicleId = "";
// Problematic resources.
let maintenanceVehicleId = ""; // status=maintenance ⇒ resource_status BLOCK (vehicle_maintenance)
let blockedDriverId = ""; // status=blocked ⇒ resource_status BLOCK (driver_blocked)
let expiredLicenseDriverId = ""; // license_expiry past ⇒ documentation BLOCK (doc_expired)
let missingDocVehicleId = ""; // document_expiry null ⇒ documentation WARN (doc_missing)
let vanVehicleId = ""; // vehicle_type=van ≠ trip planned truck ⇒ vehicle_type WARN (type_mismatch)
let expiredCarrierId = ""; // contract_status=expired ⇒ carrier_eligibility BLOCK
const tripIds: string[] = [];
// Trips reserved for the schedule-overlap construction.
let overlapTripA = "";
let overlapTripB = "";

const WINDOW_START = new Date("2026-08-01T08:00:00.000Z");
const WINDOW_END = new Date("2026-08-01T18:00:00.000Z");

async function seedReceivedTrip(plannedVehicleType: string | null = "truck"): Promise<string> {
  const inserted = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId: code("EXT-WARN"),
      originLocationId: originId,
      destinationLocationId: destId,
      currentStatus: "received",
      originalPlan: { customerId, originLocationId: originId, destinationLocationId: destId },
      plannedVehicleType,
      plannedPickupWindowStart: WINDOW_START,
      plannedDeliveryWindowEnd: WINDOW_END,
    })
    .returning({ id: trips.id });
  const id = inserted[0]!.id;
  tripIds.push(id);
  return id;
}

function findingFor(findings: Finding[], check: string): Finding | undefined {
  return findings.find((f) => f.check === check);
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
    .values({ name: "Cliente Warnings US2", customerCode: code("CUST") })
    .returning({ id: customers.id });
  customerId = cust[0]!.id;

  const origin = await db
    .insert(locations)
    .values({ customerId, code: code("ORIG"), name: "Origem Warnings" })
    .returning({ id: locations.id });
  originId = origin[0]!.id;
  const dest = await db
    .insert(locations)
    .values({ customerId, code: code("DEST"), name: "Destino Warnings" })
    .returning({ id: locations.id });
  destId = dest[0]!.id;

  const mkDriver = async (
    overrides: Partial<typeof drivers.$inferInsert>,
  ): Promise<string> => {
    const r = await db
      .insert(drivers)
      .values({
        name: `Motorista ${code("D")}`,
        ownershipType: "owned",
        status: "active",
        licenseExpiry: farFutureDate(),
        ...overrides,
      })
      .returning({ id: drivers.id });
    return r[0]!.id;
  };
  const mkVehicle = async (
    overrides: Partial<typeof vehicles.$inferInsert>,
  ): Promise<string> => {
    const r = await db
      .insert(vehicles)
      .values({
        plate: uniquePlate(),
        vehicleType: "truck",
        ownershipType: "owned",
        status: "active",
        documentExpiry: farFutureDate(),
        ...overrides,
      })
      .returning({ id: vehicles.id });
    return r[0]!.id;
  };

  cleanDriverId = await mkDriver({});
  cleanVehicleId = await mkVehicle({});
  overlapDriverId = await mkDriver({});
  overlapVehicleId = await mkVehicle({});
  blockedDriverId = await mkDriver({ status: "blocked" });
  expiredLicenseDriverId = await mkDriver({ licenseExpiry: isoDateOffsetDays(-5) });
  maintenanceVehicleId = await mkVehicle({ status: "maintenance" });
  missingDocVehicleId = await mkVehicle({ documentExpiry: null });
  vanVehicleId = await mkVehicle({ vehicleType: "van" });

  const car = await db
    .insert(carriers)
    .values({
      name: `Transportadora Vencida ${code("C")}`,
      contractStatus: "expired",
      documentationStatus: "complete",
    })
    .returning({ id: carriers.id });
  expiredCarrierId = car[0]!.id;

  // Schedule-overlap construction: trip A holds a current assignment for the DEDICATED overlap pair
  // over a window that intersects trip B's window; picking the same resources for B must flag
  // schedule_conflict. The general `cleanDriver/cleanVehicle` are NEVER pre-assigned, so they stay
  // conflict-free for every other test (incl. "clean resources → no findings").
  overlapTripA = await seedReceivedTrip();
  overlapTripB = await seedReceivedTrip();
  await db.insert(tripAssignments).values({
    tripId: overlapTripA,
    driverId: overlapDriverId,
    vehicleId: overlapVehicleId,
    assignedByUserId: admin[0]!.id,
    isCurrent: true,
  });
});

test.afterAll(async () => {
  if (tripIds.length) {
    await db.delete(tripAssignments).where(inArray(tripAssignments.tripId, tripIds));
    await db.delete(tripEvents).where(inArray(tripEvents.tripId, tripIds));
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, tripIds));
    await db.delete(trips).where(inArray(trips.id, tripIds));
  }
  const driverIds = [
    cleanDriverId,
    overlapDriverId,
    blockedDriverId,
    expiredLicenseDriverId,
  ].filter(Boolean);
  const vehicleIds = [
    cleanVehicleId,
    overlapVehicleId,
    maintenanceVehicleId,
    missingDocVehicleId,
    vanVehicleId,
  ].filter(Boolean);
  if (driverIds.length) await db.delete(drivers).where(inArray(drivers.id, driverIds));
  if (vehicleIds.length) await db.delete(vehicles).where(inArray(vehicles.id, vehicleIds));
  if (expiredCarrierId) await db.delete(carriers).where(eq(carriers.id, expiredCarrierId));
  for (const id of [originId, destId]) {
    if (id) await db.delete(locations).where(eq(locations.id, id));
  }
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

test.describe("US2 — each §19.2 finding surfaces with the right severity (dry-run check)", () => {
  test("schedule conflict → schedule_conflict WARN", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const res = await ctx.post(`/api/trips/${overlapTripB}/assignment/check`, {
      data: { driverId: overlapDriverId, vehicleId: overlapVehicleId },
    });
    expect(res.status()).toBe(200);
    const { findings } = (await res.json()) as { findings: Finding[] };
    const f = findingFor(findings, "schedule_conflict");
    expect(f, JSON.stringify(findings)).toBeTruthy();
    expect(f!.severity).toBe("warn");
    expect(f!.code).toBe("schedule_overlap");
  });

  test("vehicle in maintenance → resource_status BLOCK", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const tripId = await seedReceivedTrip();
    const res = await ctx.post(`/api/trips/${tripId}/assignment/check`, {
      data: { driverId: cleanDriverId, vehicleId: maintenanceVehicleId },
    });
    expect(res.status()).toBe(200);
    const { findings } = (await res.json()) as { findings: Finding[] };
    const f = findingFor(findings, "resource_status");
    expect(f, JSON.stringify(findings)).toBeTruthy();
    expect(f!.severity).toBe("block");
    expect(f!.code).toBe("vehicle_maintenance");
  });

  test("vehicle type ≠ planned type → vehicle_type WARN", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const tripId = await seedReceivedTrip("truck"); // planned truck, pick a van
    const res = await ctx.post(`/api/trips/${tripId}/assignment/check`, {
      data: { driverId: cleanDriverId, vehicleId: vanVehicleId },
    });
    expect(res.status()).toBe(200);
    const { findings } = (await res.json()) as { findings: Finding[] };
    const f = findingFor(findings, "vehicle_type");
    expect(f, JSON.stringify(findings)).toBeTruthy();
    expect(f!.severity).toBe("warn");
    expect(f!.code).toBe("type_mismatch");
  });

  test("carrier with expired contract → carrier_eligibility BLOCK", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const tripId = await seedReceivedTrip();
    const res = await ctx.post(`/api/trips/${tripId}/assignment/check`, {
      data: { driverId: cleanDriverId, vehicleId: cleanVehicleId, carrierId: expiredCarrierId },
    });
    expect(res.status()).toBe(200);
    const { findings } = (await res.json()) as { findings: Finding[] };
    const f = findingFor(findings, "carrier_eligibility");
    expect(f, JSON.stringify(findings)).toBeTruthy();
    expect(f!.severity).toBe("block");
    expect(f!.code).toBe("carrier_contract_expired");
  });

  test("driver with an expired license → documentation BLOCK", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const tripId = await seedReceivedTrip();
    const res = await ctx.post(`/api/trips/${tripId}/assignment/check`, {
      data: { driverId: expiredLicenseDriverId, vehicleId: cleanVehicleId },
    });
    expect(res.status()).toBe(200);
    const { findings } = (await res.json()) as { findings: Finding[] };
    const f = findings.find((x) => x.check === "documentation" && x.resourceKind === "driver");
    expect(f, JSON.stringify(findings)).toBeTruthy();
    expect(f!.severity).toBe("block");
    expect(f!.code).toBe("doc_expired");
  });

  test("vehicle with missing documentation → documentation WARN", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const tripId = await seedReceivedTrip();
    const res = await ctx.post(`/api/trips/${tripId}/assignment/check`, {
      data: { driverId: cleanDriverId, vehicleId: missingDocVehicleId },
    });
    expect(res.status()).toBe(200);
    const { findings } = (await res.json()) as { findings: Finding[] };
    const f = findings.find((x) => x.check === "documentation" && x.resourceKind === "vehicle");
    expect(f, JSON.stringify(findings)).toBeTruthy();
    expect(f!.severity).toBe("warn");
    expect(f!.code).toBe("doc_missing");
  });

  test("clean resources → no findings", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const tripId = await seedReceivedTrip();
    const res = await ctx.post(`/api/trips/${tripId}/assignment/check`, {
      data: { driverId: cleanDriverId, vehicleId: cleanVehicleId },
    });
    expect(res.status()).toBe(200);
    const { findings } = (await res.json()) as { findings: Finding[] };
    expect(findings).toEqual([]);
  });
});

test.describe("US2 — a BLOCK is server-authoritative (UI bypassed)", () => {
  test("direct assign with a BLOCK resource → 409 ASSIGNMENT_BLOCKED with findings", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const tripId = await seedReceivedTrip();

    // The UI would disable Save on a BLOCK; posting directly proves the server still refuses it. A
    // maintenance vehicle is a BLOCK and is not overridable, even with an override reason supplied.
    const res = await ctx.post(`/api/trips/${tripId}/assignment`, {
      data: {
        driverId: cleanDriverId,
        vehicleId: maintenanceVehicleId,
        expectedFromStatus: "received",
        overrideReason: "Tentativa de ignorar bloqueio",
      },
    });
    expect(res.status()).toBe(409);
    const body = (await res.json()) as { error: { code: string }; findings?: Finding[] };
    expect(body.error.code).toBe("ASSIGNMENT_BLOCKED");
    expect(body.findings && body.findings.some((f) => f.severity === "block")).toBe(true);

    // No state change: the trip is still `received` with no current assignment.
    const detail = await ctx.get(`/api/trips/${tripId}`);
    const { item } = (await detail.json()) as {
      item: { currentStatus: string; currentAssignment: unknown };
    };
    expect(item.currentStatus).toBe("received");
    expect(item.currentAssignment).toBeNull();
  });

  test("direct assign with a WARN and no override reason → 409 OVERRIDE_REQUIRED", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const tripId = await seedReceivedTrip("truck");

    // A van vs planned truck is a WARN; without an override reason the server refuses.
    const res = await ctx.post(`/api/trips/${tripId}/assignment`, {
      data: { driverId: cleanDriverId, vehicleId: vanVehicleId, expectedFromStatus: "received" },
    });
    expect(res.status()).toBe(409);
    const body = (await res.json()) as { error: { code: string }; findings?: Finding[] };
    expect(body.error.code).toBe("OVERRIDE_REQUIRED");
    expect(body.findings && body.findings.length).toBeGreaterThan(0);
  });
});
