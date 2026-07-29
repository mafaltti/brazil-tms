import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, db, drivers, resourceDocuments, users } from "@brazil-tms/db";
import {
  assertResourceDocumentParent,
  createResourceDocument,
  getResourceDocumentFileKey,
  listResourceDocuments,
} from "./resource-documents-service";

/**
 * Slice 025 — integration tests against the live dev DB (skip without DATABASE_URL, repo
 * convention). The service is storage-free by design (the ROUTE stores the binary), so these cover
 * the full DB side: parent preflight (missing → NOT_FOUND; archived → ARCHIVED_RESOURCE for
 * uploads while history stays listable), insert + audit in one tx, newest-first ordering, and the
 * file-key lookup the download route uses.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("resource-documents-service (integration)", () => {
  let actorId = "";
  let driverId = "";
  const documentIds: string[] = [];

  beforeAll(async () => {
    const admin = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "admin@braziltransports.com.br"))
      .limit(1);
    actorId = admin[0]?.id ?? "";
    expect(actorId, "seeded admin must exist (run db:seed)").not.toBe("");

    const inserted = await db
      .insert(drivers)
      .values({ name: `Docs Teste ${Date.now()}`, ownershipType: "owned" })
      .returning();
    driverId = inserted[0]!.id;
  });

  afterAll(async () => {
    for (const id of documentIds) {
      await db.delete(resourceDocuments).where(eq(resourceDocuments.id, id));
    }
    await db.delete(auditLogs).where(eq(auditLogs.entityId, driverId));
    await db.delete(drivers).where(eq(drivers.id, driverId));
  });

  function input(docType: string) {
    const id = randomUUID();
    documentIds.push(id);
    return {
      id,
      entityType: "driver" as const,
      entityId: driverId,
      docType,
      fileName: `${docType}.pdf`,
      contentType: "application/pdf",
      sizeBytes: 1234,
      fileStorageKey: `resources/driver/${driverId}/${id}.pdf`,
    };
  }

  it("create inserts the row and audits driver.document_upload in the same tx", async () => {
    const dto = await createResourceDocument(input("CNH digital"), actorId);
    expect(dto.docType).toBe("CNH digital");
    expect(dto.uploadedByUserId).toBe(actorId);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.entityId, driverId), eq(auditLogs.action, "driver.document_upload")),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it("history is append-only and newest first; the file key resolves for the download route", async () => {
    const second = await createResourceDocument(input("Photocheck"), actorId);
    const items = await listResourceDocuments("driver", driverId);
    expect(items.length).toBeGreaterThanOrEqual(2);
    // Newest first — the most recent upload tops the history.
    expect(items[0]!.id).toBe(second.id);
    // Both CNH entries remain (no replacement).
    expect(items.map((d) => d.docType)).toContain("CNH digital");

    const key = await getResourceDocumentFileKey("driver", driverId, second.id);
    expect(key).toBe(`resources/driver/${driverId}/${second.id}.pdf`);
    // A mismatched entity yields null (no cross-entity leakage).
    expect(await getResourceDocumentFileKey("vehicle", driverId, second.id)).toBeNull();
  });

  it("preflight: missing parent → NOT_FOUND; archived parent blocks uploads but keeps history readable", async () => {
    await expect(
      assertResourceDocumentParent("driver", randomUUID(), { forUpload: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await db
      .update(drivers)
      .set({ archivedAt: new Date() })
      .where(eq(drivers.id, driverId));
    await expect(
      assertResourceDocumentParent("driver", driverId, { forUpload: true }),
    ).rejects.toMatchObject({ code: "ARCHIVED_RESOURCE" });
    // The INSERT transaction re-checks the parent under a row lock (archive-race guard): even if
    // the route's preflight passed earlier, an archived parent must reject at insert time.
    await expect(
      createResourceDocument(input("Race Doc"), actorId),
    ).rejects.toMatchObject({ code: "ARCHIVED_RESOURCE" });
    await expect(
      createResourceDocument({ ...input("Orphan Doc"), entityId: randomUUID() }, actorId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Listing still works — history remains accessible on archived resources.
    const items = await listResourceDocuments("driver", driverId);
    expect(items.length).toBeGreaterThanOrEqual(2);
  });
});
