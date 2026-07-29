import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditLogs,
  customers,
  db,
  documents,
  documentTypes,
  locations,
  trips,
  users,
} from "@brazil-tms/db";
import { randomUUID } from "node:crypto";
import {
  archiveDocument,
  assertUploadable,
  getDocumentFileKey,
  uploadDocument,
  verifyDocument,
} from "./documents";
import { Conflict } from "@/lib/api/respond";

/**
 * Feature 008 (US1, T058) — document services against the live dev DB. Static imports (the Drizzle
 * client connects lazily); skips when DATABASE_URL is unset. Storage is NOT touched here — the service
 * persists metadata only (the route puts the binary), so a fake storage key is passed.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("document services (integration, US1)", () => {
  let actorId = "";
  let customerId = "";
  let originId = "";
  let destId = "";
  let tripId = "";
  let activeTypeId = "";
  let inactiveTypeId = "";
  const createdDocIds: string[] = [];
  const createdTypeIds: string[] = [];

  function code(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  beforeAll(async () => {
    const admin = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "admin@braziltransports.com.br"))
      .limit(1);
    actorId = admin[0]?.id ?? "";
    expect(actorId, "seeded admin must exist (run db:seed)").not.toBe("");

    const cust = await db
      .insert(customers)
      .values({ name: "Cliente Docs", customerCode: code("CUST") })
      .returning();
    customerId = cust[0]!.id;
    const origin = await db
      .insert(locations)
      .values({ customerId, code: code("ORIG"), name: "Origem Docs" })
      .returning();
    originId = origin[0]!.id;
    const dest = await db
      .insert(locations)
      .values({ customerId, code: code("DEST"), name: "Destino Docs" })
      .returning();
    destId = dest[0]!.id;
    const trip = await db
      .insert(trips)
      .values({
        customerId,
        originLocationId: originId,
        destinationLocationId: destId,
        originalPlan: {},
        currentStatus: "unloaded",
      })
      .returning({ id: trips.id });
    tripId = trip[0]!.id;

    const active = await db
      .insert(documentTypes)
      .values({ code: code("dt-active"), labelPt: "Tipo Ativo" })
      .returning();
    activeTypeId = active[0]!.id;
    createdTypeIds.push(activeTypeId);
    const inactive = await db
      .insert(documentTypes)
      .values({ code: code("dt-inactive"), labelPt: "Tipo Inativo", active: false })
      .returning();
    inactiveTypeId = inactive[0]!.id;
    createdTypeIds.push(inactiveTypeId);
  });

  afterAll(async () => {
    for (const id of createdDocIds) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(documents).where(eq(documents.id, id));
    }
    if (tripId) {
      await db.delete(documents).where(eq(documents.tripId, tripId));
      await db.delete(auditLogs).where(eq(auditLogs.entityId, tripId));
      await db.delete(trips).where(eq(trips.id, tripId));
    }
    for (const id of createdTypeIds) {
      await db.delete(documentTypes).where(eq(documentTypes.id, id));
    }
    for (const id of [originId, destId]) {
      if (id) await db.delete(locations).where(eq(locations.id, id));
    }
    if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
  });

  it("uploadDocument inserts a pending_review row + a document.upload audit", async () => {
    const detail = await uploadDocument(
      tripId,
      { documentTypeId: activeTypeId, fileStorageKey: `trips/${tripId}/fake.pdf`, externalReference: "CTE-1" },
      actorId,
    );
    expect(detail.documents.length).toBeGreaterThan(0);
    const doc = detail.documents.find((d) => d.externalReference === "CTE-1");
    expect(doc).toBeDefined();
    expect(doc!.verificationStatus).toBe("pending_review");
    createdDocIds.push(doc!.id);

    const audit = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, doc!.id), eq(auditLogs.action, "document.upload")));
    expect(audit.length).toBe(1);
  });

  it("verifyDocument sets status + verifier + timestamp + a document.verify audit", async () => {
    const docId = createdDocIds[0]!;
    const detail = await verifyDocument(docId, { verificationStatus: "accepted" }, actorId);
    const doc = detail.documents.find((d) => d.id === docId);
    expect(doc!.verificationStatus).toBe("accepted");
    expect(doc!.verifiedByUserId).toBe(actorId);
    expect(doc!.verifiedAt).not.toBeNull();

    const audit = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, docId), eq(auditLogs.action, "document.verify")));
    expect(audit.length).toBe(1);
  });

  it("archiveDocument soft-deletes (sets archived_at) + a document.archive audit; row drops off the detail", async () => {
    const docId = createdDocIds[0]!;
    const detail = await archiveDocument(docId, actorId);
    // The detail's documents are non-archived only, so the archived doc is gone.
    expect(detail.documents.find((d) => d.id === docId)).toBeUndefined();

    const row = await db
      .select({ archivedAt: documents.archivedAt })
      .from(documents)
      .where(eq(documents.id, docId))
      .limit(1);
    expect(row[0]!.archivedAt).not.toBeNull();

    const audit = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, docId), eq(auditLogs.action, "document.archive")));
    expect(audit.length).toBe(1);
  });

  it("uploadDocument on an inactive type ⇒ INVALID_DOCUMENT_TYPE (nothing stored)", async () => {
    await expect(
      uploadDocument(
        tripId,
        { documentTypeId: inactiveTypeId, fileStorageKey: `trips/${tripId}/x.pdf` },
        actorId,
      ),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT_TYPE" });
    expect(Conflict).toBeDefined();
  });

  it("getDocumentFileKey returns null for an archived document (no signed URL after archive)", async () => {
    const detail = await uploadDocument(
      tripId,
      { documentTypeId: activeTypeId, fileStorageKey: `trips/${tripId}/arch.pdf` },
      actorId,
    );
    const doc = detail.documents.find((d) => d.fileStorageKey === `trips/${tripId}/arch.pdf`)!;
    createdDocIds.push(doc.id);
    expect(await getDocumentFileKey(tripId, doc.id)).not.toBeNull(); // live → downloadable
    await archiveDocument(doc.id, actorId);
    expect(await getDocumentFileKey(tripId, doc.id)).toBeNull(); // archived → no key (404 at the route)
  });

  it("assertUploadable: missing trip ⇒ NotFound (404); inactive type ⇒ INVALID_DOCUMENT_TYPE (409) — before any store", async () => {
    await expect(assertUploadable(randomUUID(), activeTypeId)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    await expect(assertUploadable(tripId, inactiveTypeId)).rejects.toMatchObject({
      code: "INVALID_DOCUMENT_TYPE",
      status: 409,
    });
    // a valid (trip, active type) pair preflights cleanly.
    await expect(assertUploadable(tripId, activeTypeId)).resolves.toBeUndefined();
  });
});
