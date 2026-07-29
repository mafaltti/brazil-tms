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
  documentTypes,
  exportBatches,
  locations,
  trips,
} from "@brazil-tms/db";
import { testAccounts } from "./test-config";

/**
 * Feature 008 — documents (T059). Route-level HTTP/authz for proof-document upload, validation,
 * verification, and signed download.
 *
 *  - Upload a proof document (multipart, `upload_documents` holder = Dispatcher) → 201, `pending_review`.
 *  - A disallowed type (.exe) → 409 UNSUPPORTED_FILE_TYPE; an oversize file → 409 FILE_TOO_LARGE — and
 *    nothing is stored (R9: validated BEFORE storing).
 *  - Verify accepted (`verify_documents` holder = Finance / Ops Mgr) → 200; a non-holder (Dispatcher
 *    holds upload but NOT verify) → 403 on PATCH.
 *  - Download → 200 `{ url }`.
 *  - Unauthenticated upload → 401.
 *
 * Self-seeds via `@brazil-tms/db`; FK-safe cleanup; requires the app + DB.
 */

function code(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}
const SOME_UUID = "00000000-0000-0000-0000-000000000000";

async function apiLogin(
  request: APIRequestContext,
  account: { email: string; password: string },
): Promise<void> {
  const res = await request.post("/api/auth/sign-in", {
    data: { email: account.email, password: account.password },
  });
  expect(res.ok()).toBeTruthy();
}

const PDF = { name: "pod.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 test") };

let customerId = "";
let originId = "";
let destId = "";
let docTypeId = "";
let inactiveDocTypeId = "";
const tripIds: string[] = [];

async function seedTrip(currentStatus = "in_transit"): Promise<string> {
  const inserted = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId: code("EXT-DOC"),
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
    .values({ name: "Cliente Docs 008", customerCode: code("CUST") })
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
    .values({ code: code("DT"), labelPt: "Comprovante de entrega" })
    .returning({ id: documentTypes.id });
  docTypeId = dt[0]!.id;
  const dtInactive = await db
    .insert(documentTypes)
    .values({ code: code("DTX"), labelPt: "Tipo Inativo", active: false })
    .returning({ id: documentTypes.id });
  inactiveDocTypeId = dtInactive[0]!.id;
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
  if (customerId) await db.delete(exportBatches).where(eq(exportBatches.customerId, customerId));
  if (docTypeId) await db.delete(documentTypes).where(eq(documentTypes.id, docTypeId));
  if (inactiveDocTypeId) await db.delete(documentTypes).where(eq(documentTypes.id, inactiveDocTypeId));
  for (const id of [originId, destId]) if (id) await db.delete(locations).where(eq(locations.id, id));
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

test.describe("008 documents — upload / validate", () => {
  test("Dispatcher uploads a PDF → 201 pending_review; .exe → 409; oversize → 409; nothing stored", async ({
    request,
  }) => {
    const tripId = await seedTrip();

    // Unauthenticated upload → 401.
    const noAuth = await request.post(`/api/trips/${tripId}/documents`, {
      multipart: { file: PDF, meta: JSON.stringify({ documentTypeId: docTypeId, fileName: "pod.pdf" }) },
    });
    expect(noAuth.status()).toBe(401);

    // Holder (Dispatcher holds upload_documents) → 201, document is pending_review.
    await apiLogin(request, testAccounts.dispatcher);
    const ok = await request.post(`/api/trips/${tripId}/documents`, {
      multipart: { file: PDF, meta: JSON.stringify({ documentTypeId: docTypeId, fileName: "pod.pdf" }) },
    });
    expect(ok.status()).toBe(201);
    const { item } = (await ok.json()) as {
      item: { documents: Array<{ id: string; verificationStatus: string }> };
    };
    expect(item.documents[0]!.verificationStatus).toBe("pending_review");

    // Disallowed type → 409 UNSUPPORTED_FILE_TYPE; nothing stored.
    const exe = await request.post(`/api/trips/${tripId}/documents`, {
      multipart: {
        file: { name: "x.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") },
        meta: JSON.stringify({ documentTypeId: docTypeId, fileName: "x.exe" }),
      },
    });
    expect(exe.status()).toBe(409);
    expect(((await exe.json()) as { error: { code: string } }).error.code).toBe("UNSUPPORTED_FILE_TYPE");

    // Oversize file (> ~10 MB) → 409 FILE_TOO_LARGE; nothing stored.
    const big = await request.post(`/api/trips/${tripId}/documents`, {
      multipart: {
        file: { name: "big.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(11 * 1024 * 1024) },
        meta: JSON.stringify({ documentTypeId: docTypeId, fileName: "big.pdf" }),
      },
    });
    expect(big.status()).toBe(409);
    expect(((await big.json()) as { error: { code: string } }).error.code).toBe("FILE_TOO_LARGE");

    // Only the valid upload was stored.
    const stored = await db.select({ id: documents.id }).from(documents).where(eq(documents.tripId, tripId));
    expect(stored.length).toBe(1);
  });
});

test.describe("008 documents — verify + download", () => {
  test("verify accepted (Finance) → 200; download → 200 { url }; Dispatcher (no verify) → 403", async ({
    request,
  }) => {
    const tripId = await seedTrip();

    await apiLogin(request, testAccounts.dispatcher);
    const upload = await request.post(`/api/trips/${tripId}/documents`, {
      multipart: { file: PDF, meta: JSON.stringify({ documentTypeId: docTypeId, fileName: "pod.pdf" }) },
    });
    expect(upload.status()).toBe(201);
    const { item } = (await upload.json()) as { item: { documents: Array<{ id: string }> } };
    const docId = item.documents[0]!.id;

    // Dispatcher holds upload_documents but NOT verify_documents → 403 on verify.
    const deny = await request.patch(`/api/documents/${docId}`, {
      data: { verificationStatus: "accepted" },
    });
    expect(deny.status()).toBe(403);

    // Finance holds verify_documents → 200.
    await apiLogin(request, testAccounts.nonAdmin);
    const verify = await request.patch(`/api/documents/${docId}`, {
      data: { verificationStatus: "accepted", notes: "ok" },
    });
    expect(verify.status()).toBe(200);

    // Ops Manager also holds verify_documents → 200 (re-verify path).
    await apiLogin(request, testAccounts.opsManager);
    const reVerify = await request.patch(`/api/documents/${docId}`, {
      data: { verificationStatus: "pending_review" },
    });
    expect(reVerify.status()).toBe(200);

    // Download (any reader on view_all_trips) → 200 { url }.
    const dl = await request.get(`/api/trips/${tripId}/documents/${docId}/download`);
    expect(dl.status()).toBe(200);
    expect(((await dl.json()) as { url: string }).url).toBeTruthy();

    // After ARCHIVING the document, its download URL path 404s (no signed URL for an archived doc).
    await apiLogin(request, testAccounts.dispatcher); // holds upload_documents (archive)
    const archived = await request.delete(`/api/documents/${docId}`);
    expect(archived.status()).toBe(200);
    const dlArchived = await request.get(`/api/trips/${tripId}/documents/${docId}/download`);
    expect(dlArchived.status()).toBe(404);
  });
});

test.describe("008 documents — upload preflight (nothing stored on a bad ref)", () => {
  test("missing trip → 404; inactive type → 409 INVALID_DOCUMENT_TYPE (nothing stored)", async ({
    request,
  }) => {
    await apiLogin(request, testAccounts.dispatcher);

    // A missing trip is preflighted to a clean 404 (not a 500 from the FK).
    const missingTrip = await request.post(`/api/trips/${SOME_UUID}/documents`, {
      multipart: { file: PDF, meta: JSON.stringify({ documentTypeId: docTypeId, fileName: "pod.pdf" }) },
    });
    expect(missingTrip.status()).toBe(404);

    // An inactive document type → 409 INVALID_DOCUMENT_TYPE, and nothing is stored for the trip.
    const tripId = await seedTrip();
    const badType = await request.post(`/api/trips/${tripId}/documents`, {
      multipart: {
        file: PDF,
        meta: JSON.stringify({ documentTypeId: inactiveDocTypeId, fileName: "pod.pdf" }),
      },
    });
    expect(badType.status()).toBe(409);
    expect(((await badType.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_DOCUMENT_TYPE",
    );
    const stored = await db.select({ id: documents.id }).from(documents).where(eq(documents.tripId, tripId));
    expect(stored.length).toBe(0); // preflight rejected before storing
  });
});
