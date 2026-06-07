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
  vehicles,
} from "@brazil-tms/db";
import { testAccounts } from "./test-config";

/**
 * Feature 007 US1 — execution timeline e2e, driven HTTP-level against the running app (the project
 * keeps route status/permission assertions in Playwright; web Vitest only covers `lib/**`). Records
 * milestones + notes the way the interactive timeline does; asserts the illegal-jump 409 and the
 * non-holder 403. Self-seeds via `@brazil-tms/db` (a Playwright spec cannot import the `server-only`
 * services). Requires the app + seeded e2e accounts + DATABASE_URL for the test process.
 */

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
): Promise<void> {
  const res = await request.post("/api/auth/sign-in", {
    data: { email: account.email, password: account.password },
  });
  expect(res.ok()).toBeTruthy();
}

let customerId = "";
let originId = "";
let destId = "";
let driverId = "";
let vehicleId = "";
const tripIds: string[] = [];
let windowDay = 1;

/** A fresh `received` trip with a distinct planned window (so reused fleet never schedule-overlaps). */
async function seedTrip(): Promise<string> {
  const day = String(windowDay++).padStart(2, "0");
  const inserted = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId: code("EXT-EXEC"),
      originLocationId: originId,
      destinationLocationId: destId,
      currentStatus: "received",
      originalPlan: {},
      plannedVehicleType: "truck",
      plannedPickupWindowStart: new Date(`2026-08-${day}T08:00:00.000Z`),
      plannedDeliveryWindowEnd: new Date(`2026-08-${day}T18:00:00.000Z`),
    })
    .returning({ id: trips.id });
  const id = inserted[0]!.id;
  tripIds.push(id);
  return id;
}

/** Drive received → confirmed (assign, confirm) so milestones are reachable. */
async function toConfirmed(request: APIRequestContext, tripId: string): Promise<void> {
  let res = await request.post(`/api/trips/${tripId}/assignment`, {
    data: { driverId, vehicleId, expectedFromStatus: "received", overrideReason: "e2e" },
  });
  expect(res.ok(), "assign").toBeTruthy();
  res = await request.post(`/api/trips/${tripId}/assignment/confirm`, {
    data: { expectedFromStatus: "assigned" },
  });
  expect(res.ok(), "confirm").toBeTruthy();
}

test.beforeAll(async () => {
  const cust = await db
    .insert(customers)
    .values({ name: "Cliente Exec US1", customerCode: code("CUST") })
    .returning({ id: customers.id });
  customerId = cust[0]!.id;
  const origin = await db
    .insert(locations)
    .values({ customerId, code: code("ORIG"), name: "Origem Exec" })
    .returning({ id: locations.id });
  originId = origin[0]!.id;
  const dest = await db
    .insert(locations)
    .values({ customerId, code: code("DEST"), name: "Destino Exec" })
    .returning({ id: locations.id });
  destId = dest[0]!.id;
  const drv = await db
    .insert(drivers)
    .values({ name: `Motorista Exec ${code("D")}`, ownershipType: "owned", status: "active", licenseExpiry: farFutureDate() })
    .returning({ id: drivers.id });
  driverId = drv[0]!.id;
  const veh = await db
    .insert(vehicles)
    .values({ plate: uniquePlate(), vehicleType: "truck", ownershipType: "owned", status: "active", documentExpiry: farFutureDate() })
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
  for (const id of [originId, destId]) if (id) await db.delete(locations).where(eq(locations.id, id));
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

test.describe("007 US1 — execution timeline", () => {
  test("advances milestones confirmed→completed; the timeline records them chronologically", async ({
    request,
  }) => {
    await apiLogin(request, testAccounts.dispatcher);
    const tripId = await seedTrip();
    await toConfirmed(request, tripId);

    const chain: [string, string][] = [
      ["confirmed", "at_origin"],
      ["at_origin", "loading"],
      ["loading", "loaded"],
      ["loaded", "in_transit"],
      ["in_transit", "at_destination"],
      ["at_destination", "unloading"],
      ["unloading", "unloaded"],
      ["unloaded", "completed"],
    ];
    for (const [from, to] of chain) {
      const res = await request.post(`/api/trips/${tripId}/status`, {
        data: { expectedFromStatus: from, toStatus: to, eventTimestamp: new Date().toISOString() },
      });
      expect(res.ok(), `${from}→${to}`).toBeTruthy();
    }

    const detail = await request.get(`/api/trips/${tripId}`);
    const { item } = (await detail.json()) as {
      item: { currentStatus: string; events: { eventType: string }[] };
    };
    expect(item.currentStatus).toBe("completed");
    expect(item.events.filter((e) => e.eventType === "status_change").length).toBeGreaterThanOrEqual(8);
  });

  test("a free-form note appears without a status change", async ({ request }) => {
    await apiLogin(request, testAccounts.dispatcher);
    const tripId = await seedTrip();

    const res = await request.post(`/api/trips/${tripId}/events`, { data: { notes: "Observação de execução." } });
    expect(res.ok()).toBeTruthy();

    const detail = await request.get(`/api/trips/${tripId}`);
    const { item } = (await detail.json()) as {
      item: { currentStatus: string; events: { eventType: string; notes: string | null }[] };
    };
    expect(item.currentStatus).toBe("received");
    expect(item.events.some((e) => e.eventType === "note" && e.notes === "Observação de execução.")).toBe(true);
  });

  test("an illegal jump (Loaded before At Origin) → 409 ILLEGAL_TRANSITION", async ({ request }) => {
    await apiLogin(request, testAccounts.dispatcher);
    const tripId = await seedTrip();
    await request.post(`/api/trips/${tripId}/assignment`, {
      data: { driverId, vehicleId, expectedFromStatus: "received", overrideReason: "e2e" },
    });

    const res = await request.post(`/api/trips/${tripId}/status`, {
      data: { expectedFromStatus: "assigned", toStatus: "loaded" },
    });
    expect(res.status()).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ILLEGAL_TRANSITION");
  });

  test("a user without update_trip_status → 403 on milestone + note", async ({ request }) => {
    const tripId = await seedTrip();

    // Finance lacks update_trip_status.
    await apiLogin(request, testAccounts.nonAdmin);
    const status = await request.post(`/api/trips/${tripId}/status`, {
      data: { expectedFromStatus: "received", toStatus: "cancelled" },
    });
    expect(status.status()).toBe(403);
    const note = await request.post(`/api/trips/${tripId}/events`, { data: { notes: "x" } });
    expect(note.status()).toBe(403);
  });
});
