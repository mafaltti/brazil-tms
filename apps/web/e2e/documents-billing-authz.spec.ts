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
 * Feature 008 — the consolidated authorization matrix (T105; permission-matrix.md). 008 first-enforces
 * `upload_documents`, `verify_documents`, `mark_completed`, `mark_billing_ready`, `edit_rates`,
 * `export_billing` and reuses `manage_commercial_data` (document requirements/types). All reads stay on
 * `view_all_trips`. This spec asserts holder 2xx vs non-holder 403 for each key, the view-only read
 * surface, and the unauthenticated 401.
 *
 * Roles in the e2e seed: dispatcher (upload_documents only), nonAdmin=Finance (verify_documents,
 * mark_billing_ready, edit_rates, export_billing, upload_documents — NOT mark_completed /
 * manage_commercial_data), opsManager (upload/verify/mark_completed/manage_commercial_data — NOT
 * mark_billing_ready / edit_rates / export_billing). There is no Control-Tower / Exec-Viewer account.
 *
 * Self-seeds via `@brazil-tms/db`; FK-safe cleanup; requires the app + DB.
 */

function code(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

const PERIOD = "2026-06";
const PDF = { name: "pod.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 test") };

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
const createdRequirementIds: string[] = [];
const createdRateIds: string[] = [];
const tripIds: string[] = [];

async function seedTrip(currentStatus: string): Promise<string> {
  const inserted = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId: code("EXT-AUTHZ8"),
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

async function uploadDoc(request: APIRequestContext, tripId: string): Promise<string> {
  const res = await request.post(`/api/trips/${tripId}/documents`, {
    multipart: { file: PDF, meta: JSON.stringify({ documentTypeId: docTypeId, fileName: "pod.pdf" }) },
  });
  expect(res.status()).toBe(201);
  const { item } = (await res.json()) as { item: { documents: Array<{ id: string }> } };
  return item.documents[0]!.id;
}

test.beforeAll(async () => {
  const cust = await db
    .insert(customers)
    .values({ name: "Cliente Authz 008", customerCode: code("CUST") })
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
  if (customerId) {
    const batches = await db
      .select({ id: exportBatches.id })
      .from(exportBatches)
      .where(eq(exportBatches.customerId, customerId));
    const batchIds = batches.map((b) => b.id);
    if (batchIds.length) await db.delete(auditLogs).where(inArray(auditLogs.entityId, batchIds));
    await db.delete(exportBatches).where(eq(exportBatches.customerId, customerId));
  }
  const reqIds = [requirementId, ...createdRequirementIds].filter(Boolean);
  if (reqIds.length) {
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, reqIds));
  }
  await db.delete(documentRequirements).where(eq(documentRequirements.customerId, customerId));
  if (docTypeId) await db.delete(documentTypes).where(eq(documentTypes.id, docTypeId));
  const allRateIds = [rateId, ...createdRateIds].filter(Boolean);
  if (allRateIds.length) await db.delete(auditLogs).where(inArray(auditLogs.entityId, allRateIds));
  if (customerId) await db.delete(rates).where(eq(rates.customerId, customerId));
  for (const id of [originId, destId]) if (id) await db.delete(locations).where(eq(locations.id, id));
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

test.describe("008 authz — write keys, holder 2xx vs non-holder 403", () => {
  test("upload_documents + verify_documents", async ({ request }) => {
    const tripId = await seedTrip("in_transit");

    // upload_documents: Dispatcher (holder) → 201. (Exec Viewer — the only non-holder — is not seeded.)
    await apiLogin(request, testAccounts.dispatcher);
    const docId = await uploadDoc(request, tripId);

    // verify_documents: Dispatcher (non-holder) → 403; Finance (holder) → 200.
    expect(
      (await request.patch(`/api/documents/${docId}`, { data: { verificationStatus: "accepted" } })).status(),
    ).toBe(403);
    await apiLogin(request, testAccounts.nonAdmin);
    expect(
      (await request.patch(`/api/documents/${docId}`, { data: { verificationStatus: "accepted" } })).status(),
    ).toBe(200);
    // (The unauthenticated 401 path is asserted in the dedicated view-only/unauth describe block below.)
  });

  test("mark_completed (Ops Mgr 200 / Finance 403) + mark_billing_ready (Finance 200 / Ops Mgr 403)", async ({
    request,
  }) => {
    const tripId = await seedTrip("unloaded");
    const waive = { waivedRequirements: [{ documentTypeId: docTypeId, reason: "indisponível" }] };

    // mark_completed: Finance (non-holder) → 403; Ops Mgr (holder) → 200 (→ billing_pending).
    await apiLogin(request, testAccounts.nonAdmin);
    expect((await request.post(`/api/trips/${tripId}/complete`, { data: waive })).status()).toBe(403);
    await apiLogin(request, testAccounts.opsManager);
    expect((await request.post(`/api/trips/${tripId}/complete`, { data: waive })).status()).toBe(200);

    // mark_billing_ready: Ops Mgr (non-holder) → 403; Finance (holder) → 200.
    expect((await request.post(`/api/trips/${tripId}/billing-ready`, { data: waive })).status()).toBe(403);
    await apiLogin(request, testAccounts.nonAdmin);
    expect((await request.post(`/api/trips/${tripId}/billing-ready`, { data: waive })).status()).toBe(200);
  });

  test("edit_rates (Finance 201 / Dispatcher 403) + manage_commercial_data (Ops Mgr 201 / Dispatcher 403)", async ({
    request,
  }) => {
    const rateBody = { customerId, baseAmountCents: 99000, currency: "BRL", active: true };
    const reqBody = {
      customerId,
      documentTypeId: docTypeId,
      requiredForCompletion: false,
      requiredForBilling: true,
      active: true,
    };

    // edit_rates: Dispatcher (non-holder) → 403; Finance (holder) → 201.
    await apiLogin(request, testAccounts.dispatcher);
    expect((await request.post(`/api/rates`, { data: rateBody })).status()).toBe(403);
    // manage_commercial_data: Dispatcher (non-holder) → 403.
    expect((await request.post(`/api/document-requirements`, { data: reqBody })).status()).toBe(403);

    await apiLogin(request, testAccounts.nonAdmin);
    const rateRes = await request.post(`/api/rates`, { data: rateBody });
    expect(rateRes.status()).toBe(201);
    createdRateIds.push(((await rateRes.json()) as { item: { id: string } }).item.id);

    // manage_commercial_data: Ops Mgr (holder) → 201.
    await apiLogin(request, testAccounts.opsManager);
    const reqRes = await request.post(`/api/document-requirements`, { data: reqBody });
    expect(reqRes.status()).toBe(201);
    createdRequirementIds.push(((await reqRes.json()) as { item: { id: string } }).item.id);
  });

  test("export_billing (Finance 202 / Dispatcher 403)", async ({ request }) => {
    // Seed a billing-ready trip + item so the export set is non-empty.
    const readyTrip = await seedTrip("billing_ready");
    await db.insert(billingItems).values({
      tripId: readyTrip,
      customerId,
      baseFreightCents: 150000,
      billingPeriod: PERIOD,
    });

    // Dispatcher (non-holder) → 403.
    await apiLogin(request, testAccounts.dispatcher);
    expect(
      (
        await request.post(`/api/billing/exports`, {
          data: { customerId, billingPeriod: PERIOD, format: "csv" },
        })
      ).status(),
    ).toBe(403);

    // Finance (holder) → 202.
    await apiLogin(request, testAccounts.nonAdmin);
    expect(
      (
        await request.post(`/api/billing/exports`, {
          data: { customerId, billingPeriod: PERIOD, format: "xlsx" },
        })
      ).status(),
    ).toBe(202);
  });
});

test.describe("008 authz — view-only reads + unauthenticated", () => {
  test("Finance reads trip-detail / billing / exports / dashboard (200)", async ({ request }) => {
    const tripId = await seedTrip("in_transit");
    await apiLogin(request, testAccounts.nonAdmin);
    expect((await request.get(`/api/trips/${tripId}`)).status()).toBe(200);
    expect((await request.get(`/api/billing?scope=pending&customerId=${customerId}`)).status()).toBe(200);
    expect((await request.get(`/api/billing/exports?customerId=${customerId}`)).status()).toBe(200);
    expect((await request.get(`/api/dashboard/summary`)).status()).toBe(200);
  });

  test("unauthenticated upload → 401", async ({ request }) => {
    const tripId = await seedTrip("in_transit");
    const res = await request.post(`/api/trips/${tripId}/documents`, {
      multipart: { file: PDF, meta: JSON.stringify({ documentTypeId: docTypeId, fileName: "pod.pdf" }) },
    });
    expect(res.status()).toBe(401);
  });
});
