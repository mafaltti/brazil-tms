import { test, expect, type APIRequestContext } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";
import {
  alerts,
  auditLogs,
  billingAdjustments,
  billingItems,
  customers,
  db,
  documents,
  exportBatches,
  locations,
  rates,
  trips,
} from "@brazil-tms/db";
import { testAccounts } from "./test-config";

/**
 * Feature 008 — rates + billing values (T091). Rate maintenance + billing-item edits + typed
 * adjustments, all on the `edit_rates` key (Admin / Finance).
 *
 *  - Create a rate (Finance → 201; Dispatcher → 403).
 *  - GET rates (any reader) → 200.
 *  - PATCH a billing item (Finance → 200 on a billing_pending trip with a billing item; → 404 on a
 *    trip with no billing item).
 *  - Add an adjustment (Finance → 201) + delete it (Finance → 200).
 *  - `edit_rates` non-holder (Dispatcher) → 403 on the billing edits.
 *
 * Self-seeds via `@brazil-tms/db`; FK-safe cleanup; requires the app + DB.
 */

function code(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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
const rateIds: string[] = [];
const tripIds: string[] = [];

async function seedTrip(currentStatus: string): Promise<string> {
  const inserted = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId: code("EXT-RATE"),
      originLocationId: originId,
      destinationLocationId: destId,
      currentStatus: currentStatus as never,
      originalPlan: {},
    })
    .returning({ id: trips.id });
  const id = inserted[0]!.id;
  tripIds.push(id);
  return id;
}

/** Seed a billing item directly (a trip already in the billing phase). */
async function seedBillingItem(tripId: string): Promise<void> {
  await db.insert(billingItems).values({
    tripId,
    customerId,
    baseFreightCents: 120000,
    billingPeriod: "2026-06",
  });
}

test.beforeAll(async () => {
  const cust = await db
    .insert(customers)
    .values({ name: "Cliente Rates 008", customerCode: code("CUST") })
    .returning({ id: customers.id });
  customerId = cust[0]!.id;
  const origin = await db
    .insert(locations)
    .values({ customerId, code: code("ORIG"), name: "Origem" })
    .returning({ id: locations.id });
  originId = origin[0]!.id;
  const dest = await db
    .insert(locations)
    .values({ customerId, code: code("DEST"), name: "Destino" })
    .returning({ id: locations.id });
  destId = dest[0]!.id;
});

test.afterAll(async () => {
  if (tripIds.length) {
    await db.delete(alerts).where(inArray(alerts.tripId, tripIds));
    const items = await db
      .select({ id: billingItems.id })
      .from(billingItems)
      .where(inArray(billingItems.tripId, tripIds));
    const itemIds = items.map((r) => r.id);
    if (itemIds.length) {
      await db.delete(billingAdjustments).where(inArray(billingAdjustments.billingItemId, itemIds));
      await db.delete(auditLogs).where(inArray(auditLogs.entityId, itemIds));
    }
    await db.delete(billingItems).where(inArray(billingItems.tripId, tripIds));
    await db.delete(documents).where(inArray(documents.tripId, tripIds));
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, tripIds));
    await db.delete(trips).where(inArray(trips.id, tripIds));
  }
  if (customerId) await db.delete(exportBatches).where(eq(exportBatches.customerId, customerId));
  if (rateIds.length) {
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, rateIds));
    await db.delete(rates).where(inArray(rates.id, rateIds));
  }
  if (customerId) await db.delete(rates).where(eq(rates.customerId, customerId));
  for (const id of [originId, destId]) if (id) await db.delete(locations).where(eq(locations.id, id));
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

test.describe("008 rates — create / read authz", () => {
  test("Finance creates a rate (201); Dispatcher 403; GET rates 200", async ({ request }) => {
    const rateBody = { customerId, baseAmountCents: 150000, currency: "BRL", active: true };

    // Dispatcher does NOT hold edit_rates → 403.
    await apiLogin(request, testAccounts.dispatcher);
    expect((await request.post(`/api/rates`, { data: rateBody })).status()).toBe(403);

    // Finance (edit_rates holder) → 201.
    await apiLogin(request, testAccounts.nonAdmin);
    const ok = await request.post(`/api/rates`, { data: rateBody });
    expect(ok.status()).toBe(201);
    rateIds.push(((await ok.json()) as { item: { id: string } }).item.id);

    // Read (any reader) → 200.
    expect((await request.get(`/api/rates?customerId=${customerId}`)).status()).toBe(200);

    // PATCH a non-existent rate → 404 (NotFound), not a silent 200.
    const missing = await request.patch(`/api/rates/00000000-0000-0000-0000-000000000000`, {
      data: { baseAmountCents: 1 },
    });
    expect(missing.status()).toBe(404);
  });
});

test.describe("008 billing values — edit item + adjustments authz", () => {
  test("Finance PATCHes item (200) / 404 when none; adds + deletes adjustment; Dispatcher 403", async ({
    request,
  }) => {
    const billed = await seedTrip("billing_pending");
    await seedBillingItem(billed);
    const noItem = await seedTrip("in_transit");

    // Dispatcher (no edit_rates) → 403 on billing edit.
    await apiLogin(request, testAccounts.dispatcher);
    expect(
      (await request.patch(`/api/trips/${billed}/billing`, { data: { baseFreightCents: 99000 } })).status(),
    ).toBe(403);

    // Finance (edit_rates) → 200 on PATCH.
    await apiLogin(request, testAccounts.nonAdmin);
    const patch = await request.patch(`/api/trips/${billed}/billing`, {
      data: { baseFreightCents: 99000, disputeStatus: "none", notes: "ajustado" },
    });
    expect(patch.status()).toBe(200);

    // A trip with no billing item → 404.
    const missing = await request.patch(`/api/trips/${noItem}/billing`, {
      data: { baseFreightCents: 1000 },
    });
    expect(missing.status()).toBe(404);

    // Add a typed adjustment → 201.
    const add = await request.post(`/api/trips/${billed}/billing/adjustments`, {
      data: { type: "toll", amountCents: 5000, note: "pedágio" },
    });
    expect(add.status()).toBe(201);
    const { item } = (await add.json()) as { item: { adjustments: Array<{ id: string }> } };
    const adjId = item.adjustments[0]!.id;

    // Delete (soft-remove) the adjustment → 200.
    const del = await request.delete(`/api/billing-adjustments/${adjId}`);
    expect(del.status()).toBe(200);
  });
});
