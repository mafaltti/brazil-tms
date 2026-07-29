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
  trips,
} from "@brazil-tms/db";
import { testAccounts } from "./test-config";

/**
 * Feature 008 — billing lists + export (T102). The pending/ready lists are reads on `view_all_trips`;
 * the on-demand export is `export_billing` (Admin / Finance), enqueued off the request path.
 *
 *  - GET /api/billing?scope=pending|ready → 200 (read).
 *  - POST /api/billing/exports with no billing-ready trips → 409 NO_BILLABLE_TRIPS.
 *  - POST /api/billing/exports with a seeded billing_ready trip + billing item → 202 (queued).
 *  - GET /api/billing/exports (history) → 200.
 *  - Authz: `export_billing` holder = Finance (202) vs non-holder Dispatcher (403).
 *
 * Self-seeds via `@brazil-tms/db`; FK-safe cleanup; requires the app + DB (the 202 only enqueues — the
 * worker need not be running for this assertion).
 */

function code(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

const PERIOD = "2026-06";
const EMPTY_PERIOD = "2020-01";

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
const tripIds: string[] = [];

async function seedReadyTrip(): Promise<string> {
  const inserted = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId: code("EXT-EXP"),
      originLocationId: originId,
      destinationLocationId: destId,
      currentStatus: "billing_ready" as never,
      originalPlan: {},
    })
    .returning({ id: trips.id });
  const id = inserted[0]!.id;
  tripIds.push(id);
  await db.insert(billingItems).values({
    tripId: id,
    customerId,
    baseFreightCents: 150000,
    billingPeriod: PERIOD,
  });
  return id;
}

test.beforeAll(async () => {
  const cust = await db
    .insert(customers)
    .values({ name: "Cliente Export 008", customerCode: code("CUST") })
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
    }
    await db.delete(billingItems).where(inArray(billingItems.tripId, tripIds));
    await db.delete(documents).where(inArray(documents.tripId, tripIds));
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, tripIds));
    await db.delete(trips).where(inArray(trips.id, tripIds));
  }
  if (customerId) {
    const batches = await db
      .select({ id: exportBatches.id })
      .from(exportBatches)
      .where(eq(exportBatches.customerId, customerId));
    const batchIds = batches.map((b) => b.id);
    if (batchIds.length) await db.delete(auditLogs).where(inArray(auditLogs.entityId, batchIds));
    await db.delete(exportBatches).where(eq(exportBatches.customerId, customerId));
  }
  for (const id of [originId, destId]) if (id) await db.delete(locations).where(eq(locations.id, id));
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

test.describe("008 billing lists", () => {
  test("GET /api/billing?scope=pending|ready → 200 for a reader", async ({ request }) => {
    await apiLogin(request, testAccounts.nonAdmin);
    expect((await request.get(`/api/billing?scope=pending&customerId=${customerId}`)).status()).toBe(200);
    expect((await request.get(`/api/billing?scope=ready&customerId=${customerId}`)).status()).toBe(200);
  });
});

test.describe("008 billing export — generate + authz", () => {
  test("empty set → 409; billing_ready set → 202 (Finance); Dispatcher 403; history 200", async ({
    request,
  }) => {
    await seedReadyTrip();

    // Dispatcher does NOT hold export_billing → 403.
    await apiLogin(request, testAccounts.dispatcher);
    expect(
      (
        await request.post(`/api/billing/exports`, {
          data: { customerId, billingPeriod: PERIOD, format: "csv" },
        })
      ).status(),
    ).toBe(403);

    // Finance (export_billing holder). A period with no billing-ready trips → 409 NO_BILLABLE_TRIPS.
    await apiLogin(request, testAccounts.nonAdmin);
    const empty = await request.post(`/api/billing/exports`, {
      data: { customerId, billingPeriod: EMPTY_PERIOD, format: "csv" },
    });
    expect(empty.status()).toBe(409);
    expect(((await empty.json()) as { error: { code: string } }).error.code).toBe("NO_BILLABLE_TRIPS");

    // A non-empty billing-ready set → 202 (queued).
    const ok = await request.post(`/api/billing/exports`, {
      data: { customerId, billingPeriod: PERIOD, format: "xlsx" },
    });
    expect(ok.status()).toBe(202);

    // Export-batch history → 200.
    expect((await request.get(`/api/billing/exports?customerId=${customerId}`)).status()).toBe(200);
  });
});
