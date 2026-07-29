import { test, expect, type APIRequestContext } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  customers,
  db,
  documentRequirements,
  documentTypes,
  locations,
} from "@brazil-tms/db";
import { testAccounts } from "./test-config";

/**
 * Feature 008 — document-requirement checklist + document-type master (T079). Administered via the
 * reused `manage_commercial_data` key; reads on `view_all_trips`.
 *
 *  - Create a checklist row (`manage_commercial_data` holder = Ops Mgr) → 201.
 *  - Create a document type (Ops Mgr) → 201.
 *  - GET requirements + types (any reader) → 200.
 *  - Non-holders (Dispatcher / Finance do NOT hold manage_commercial_data) → 403 on POST.
 *  - PATCH a requirement (Ops Mgr) → 200.
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
const requirementIds: string[] = [];
const createdTypeIds: string[] = [];

test.beforeAll(async () => {
  const cust = await db
    .insert(customers)
    .values({ name: "Cliente Reqs 008", customerCode: code("CUST") })
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
    .values({ code: code("DT"), labelPt: "Canhoto" })
    .returning({ id: documentTypes.id });
  docTypeId = dt[0]!.id;
});

test.afterAll(async () => {
  const allTypeIds = [docTypeId, ...createdTypeIds].filter(Boolean);
  const allReqIds = [...requirementIds].filter(Boolean);
  if (allReqIds.length) {
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, allReqIds));
    await db.delete(documentRequirements).where(inArray(documentRequirements.id, allReqIds));
  }
  await db.delete(documentRequirements).where(eq(documentRequirements.customerId, customerId));
  if (allTypeIds.length) {
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, allTypeIds));
    await db.delete(documentTypes).where(inArray(documentTypes.id, allTypeIds));
  }
  for (const id of [originId, destId]) if (id) await db.delete(locations).where(eq(locations.id, id));
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

test.describe("008 document-requirements / document-types — admin authz", () => {
  test("Ops Mgr creates + patches (201/200); Dispatcher/Finance 403 on POST; reads 200", async ({
    request,
  }) => {
    const reqBody = {
      customerId,
      documentTypeId: docTypeId,
      requiredForCompletion: true,
      requiredForBilling: true,
      active: true,
    };
    const typeBody = { code: code("DT2"), labelPt: "Recibo de portaria", active: true };

    // Non-holders (Dispatcher + Finance) → 403 on the requirement POST.
    await apiLogin(request, testAccounts.dispatcher);
    expect((await request.post(`/api/document-requirements`, { data: reqBody })).status()).toBe(403);
    expect((await request.post(`/api/document-types`, { data: typeBody })).status()).toBe(403);
    await apiLogin(request, testAccounts.nonAdmin);
    expect((await request.post(`/api/document-requirements`, { data: reqBody })).status()).toBe(403);

    // Ops Manager (manage_commercial_data holder) → 201 on both.
    await apiLogin(request, testAccounts.opsManager);
    const reqRes = await request.post(`/api/document-requirements`, { data: reqBody });
    expect(reqRes.status()).toBe(201);
    const reqId = ((await reqRes.json()) as { item: { id: string } }).item.id;
    requirementIds.push(reqId);

    const typeRes = await request.post(`/api/document-types`, { data: typeBody });
    expect(typeRes.status()).toBe(201);
    createdTypeIds.push(((await typeRes.json()) as { item: { id: string } }).item.id);

    // PATCH the requirement (Ops Mgr) → 200.
    const patch = await request.patch(`/api/document-requirements/${reqId}`, {
      data: { active: false },
    });
    expect(patch.status()).toBe(200);

    // Reads (any reader on view_all_trips) → 200.
    await apiLogin(request, testAccounts.dispatcher);
    expect((await request.get(`/api/document-requirements?customerId=${customerId}`)).status()).toBe(200);
    expect((await request.get(`/api/document-types`)).status()).toBe(200);
  });
});
