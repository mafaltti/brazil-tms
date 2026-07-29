import { test, expect, type APIRequestContext } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";
import {
  alerts,
  auditLogs,
  billingAdjustments,
  billingItems,
  customers,
  db,
  documentRequirements,
  documents,
  documentTypes,
  exportBatches,
  locations,
  rates,
  tripEvents,
  trips,
} from "@brazil-tms/db";
import { testAccounts } from "./test-config";

/**
 * Feature 008 — completion + billing-ready (T071). These are transitions on the existing 003 status
 * machine, gated server-side (the UI never decides).
 *
 *  - mark Completed BLOCKED by a missing completion-required document → 409 COMPLETION_BLOCKED.
 *  - mark Completed WITH `waivedRequirements` → 200 (trip auto-advances to `billing_pending`).
 *  - mark Billing Ready (Finance) → 200 (after a rate auto-priced the billing item + billing docs waived).
 *  - Authz: `mark_completed` holder = Ops Mgr (200) vs non-holders Dispatcher / Finance (403);
 *    `mark_billing_ready` holder = Finance (200) vs non-holder Ops Mgr (403).
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
let docTypeId = "";
let requirementId = "";
let rateId = "";
const tripIds: string[] = [];

async function seedTrip(currentStatus = "unloaded"): Promise<string> {
  const inserted = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId: code("EXT-COMP"),
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

test.beforeAll(async () => {
  const cust = await db
    .insert(customers)
    .values({ name: "Cliente Completion 008", customerCode: code("CUST") })
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
  const dt = await db
    .insert(documentTypes)
    .values({ code: code("DT"), labelPt: "POD" })
    .returning({ id: documentTypes.id });
  docTypeId = dt[0]!.id;
  // Required for BOTH completion and billing — blocks until accepted/waived.
  const req = await db
    .insert(documentRequirements)
    .values({
      customerId,
      documentTypeId: docTypeId,
      requiredForCompletion: true,
      requiredForBilling: true,
    })
    .returning({ id: documentRequirements.id });
  requirementId = req[0]!.id;
  // A customer-default rate so `ensureBillingItem` auto-prices on completion (hasPricing ⇒ billing-ready).
  const rate = await db
    .insert(rates)
    .values({ customerId, baseAmountCents: 150000 })
    .returning({ id: rates.id });
  rateId = rate[0]!.id;
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
    await db.delete(tripEvents).where(inArray(tripEvents.tripId, tripIds));
    await db.delete(trips).where(inArray(trips.id, tripIds));
  }
  if (customerId) await db.delete(exportBatches).where(eq(exportBatches.customerId, customerId));
  if (requirementId) await db.delete(documentRequirements).where(eq(documentRequirements.id, requirementId));
  if (docTypeId) await db.delete(documentTypes).where(eq(documentTypes.id, docTypeId));
  if (rateId) await db.delete(rates).where(eq(rates.id, rateId));
  for (const id of [originId, destId]) if (id) await db.delete(locations).where(eq(locations.id, id));
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

test.describe("008 completion — gate + waiver", () => {
  test("blocked by a missing required doc → 409; with waiver → 200; then billing-ready → 200", async ({
    request,
  }) => {
    const tripId = await seedTrip("unloaded");

    // Ops Manager holds mark_completed.
    await apiLogin(request, testAccounts.opsManager);

    // No accepted/waived doc → COMPLETION_BLOCKED.
    const blocked = await request.post(`/api/trips/${tripId}/complete`, { data: {} });
    expect(blocked.status()).toBe(409);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("COMPLETION_BLOCKED");

    // Waive the required type → 200; trip auto-advances to billing_pending.
    const completed = await request.post(`/api/trips/${tripId}/complete`, {
      data: { waivedRequirements: [{ documentTypeId: docTypeId, reason: "indisponível" }] },
    });
    expect(completed.status()).toBe(200);
    const { item } = (await completed.json()) as { item: { currentStatus: string } };
    expect(item.currentStatus).toBe("billing_pending");

    // Now mark Billing Ready (Finance). Billing docs already waived + rate auto-priced ⇒ gate passes.
    await apiLogin(request, testAccounts.nonAdmin);
    const ready = await request.post(`/api/trips/${tripId}/billing-ready`, {
      data: { waivedRequirements: [{ documentTypeId: docTypeId, reason: "indisponível" }] },
    });
    expect(ready.status()).toBe(200);
    expect(((await ready.json()) as { item: { currentStatus: string } }).item.currentStatus).toBe(
      "billing_ready",
    );
  });
});

test.describe("008 completion / billing-ready — authz", () => {
  test("mark_completed: Ops Mgr 200 vs Dispatcher/Finance 403; mark_billing_ready: Finance 200 vs Ops Mgr 403", async ({
    request,
  }) => {
    // mark_completed non-holders → 403 (Dispatcher + Finance do NOT hold mark_completed).
    const tripA = await seedTrip("unloaded");
    await apiLogin(request, testAccounts.dispatcher);
    expect(
      (
        await request.post(`/api/trips/${tripA}/complete`, {
          data: { waivedRequirements: [{ documentTypeId: docTypeId, reason: "x" }] },
        })
      ).status(),
    ).toBe(403);
    await apiLogin(request, testAccounts.nonAdmin);
    expect(
      (
        await request.post(`/api/trips/${tripA}/complete`, {
          data: { waivedRequirements: [{ documentTypeId: docTypeId, reason: "x" }] },
        })
      ).status(),
    ).toBe(403);

    // Ops Mgr (holder) → 200.
    await apiLogin(request, testAccounts.opsManager);
    expect(
      (
        await request.post(`/api/trips/${tripA}/complete`, {
          data: { waivedRequirements: [{ documentTypeId: docTypeId, reason: "x" }] },
        })
      ).status(),
    ).toBe(200);

    // mark_billing_ready: Ops Mgr does NOT hold it → 403; Finance (holder) → 200.
    expect(
      (
        await request.post(`/api/trips/${tripA}/billing-ready`, {
          data: { waivedRequirements: [{ documentTypeId: docTypeId, reason: "x" }] },
        })
      ).status(),
    ).toBe(403);
    await apiLogin(request, testAccounts.nonAdmin);
    expect(
      (
        await request.post(`/api/trips/${tripA}/billing-ready`, {
          data: { waivedRequirements: [{ documentTypeId: docTypeId, reason: "x" }] },
        })
      ).status(),
    ).toBe(200);
  });
});
