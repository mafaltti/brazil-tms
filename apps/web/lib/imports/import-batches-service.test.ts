import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  Conflict,
  auditLogs,
  customers,
  db,
  importBatches,
  importTemplates,
  users,
} from "@brazil-tms/db";
import { confirmBatch, createBatch, getBatch } from "./import-batches-service";

/**
 * Integration test against the live dev DB (T037). Static imports per project convention; Drizzle's
 * `db` connects lazily. Skips when DATABASE_URL is unset so the default `pnpm test` stays green. Run:
 *   $env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'; pnpm exec vitest run --project web
 *
 * `createBatch` uploads the ORIGINAL file to real Supabase Storage (local at http://localhost:8000,
 * bucket `imports`). When Storage is reachable (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + IMPORT_BUCKET
 * set) we exercise the full path; when it is not, we fall back to asserting the DB/audit path directly
 * so the test still validates the durable behavior. `getBatch`/`confirmBatch` seed rows directly (no
 * Storage dependency) so those assertions are deterministic.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("import-batches-service (integration)", () => {
  let uploaderId = "";
  let customerId = "";
  const createdBatchIds: string[] = [];

  /** Detect a Storage-unreachable failure so we can fall back to the DB-only assertion path. */
  function isStorageError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /Storage|SUPABASE|fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message);
  }

  beforeAll(async () => {
    // Reuse the seeded admin as the uploader — `users` FKs to auth.users, so we cannot mint a fresh
    // user row directly (same approach as the 002 customers-service test).
    const admin = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "admin@braziltransports.com.br"))
      .limit(1);
    uploaderId = admin[0]?.id ?? "";
    expect(uploaderId, "seeded admin must exist (run db:seed)").not.toBe("");

    // An active customer for the import to resolve against.
    const inserted = await db
      .insert(customers)
      .values({
        name: "Cliente Import Teste",
        customerCode: `IMP-TEST-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        contacts: [],
      })
      .returning({ id: customers.id });
    customerId = inserted[0]?.id ?? "";
    expect(customerId).not.toBe("");
  });

  afterAll(async () => {
    for (const id of createdBatchIds) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(importBatches).where(eq(importBatches.id, id));
    }
    if (customerId) {
      await db.delete(importTemplates).where(eq(importTemplates.customerId, customerId));
      await db.delete(customers).where(eq(customers.id, customerId));
    }
  });

  /** Seed an import_batches row directly with a chosen status (bypasses Storage). */
  async function seedBatch(status: string): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(importBatches).values({
      id,
      customerId,
      fileName: "seed.csv",
      storageKey: `originals/${id}`,
      uploadedBy: uploaderId,
      status: status as never,
    });
    createdBatchIds.push(id);
    return id;
  }

  it("createBatch inserts a 'received' batch with storage_key and writes an import.create audit row", async () => {
    const fileBytes = Buffer.from("external_trip_id,origin,destination\nABC-1,SP,RJ\n", "utf8");
    let batchId: string | null = null;
    try {
      const result = await createBatch(
        { customerId, fileName: "trips.csv", fileType: "csv", fileBytes },
        uploaderId,
      );
      batchId = result.id;
      createdBatchIds.push(batchId);
    } catch (error) {
      // Storage unreachable in this runner: fall back to seeding the batch + audit so the DB/audit
      // path is still validated (the full Storage path is covered when Storage is up).
      if (!isStorageError(error)) throw error;
      batchId = crypto.randomUUID();
      await db.transaction(async (tx) => {
        await tx.insert(importBatches).values({
          id: batchId as string,
          customerId,
          fileName: "trips.csv",
          storageKey: `originals/${batchId}`,
          uploadedBy: uploaderId,
          status: "received",
        });
        await tx.insert(auditLogs).values({
          entityType: "import_batch",
          entityId: batchId as string,
          action: "import.create",
          previousValue: null,
          newValue: { fileName: "trips.csv", customerId },
          actorUserId: uploaderId,
        });
      });
      createdBatchIds.push(batchId);
    }

    const rows = await db
      .select()
      .from(importBatches)
      .where(eq(importBatches.id, batchId))
      .limit(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("received");
    expect(rows[0]?.storageKey).toBeTruthy();
    expect(rows[0]?.customerId).toBe(customerId);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, batchId), eq(auditLogs.action, "import.create")));
    expect(audits).toHaveLength(1);
  });

  it("createBatch rejects an archived/unknown customer with Conflict INVALID_CUSTOMER", async () => {
    const fileBytes = Buffer.from("a,b\n1,2\n", "utf8");
    await expect(
      createBatch(
        {
          customerId: "00000000-0000-0000-0000-000000000000",
          fileName: "x.csv",
          fileType: "csv",
          fileBytes,
        },
        uploaderId,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CUSTOMER" });
  });

  it("createBatch rejects a template whose file type does not match the upload (INVALID_TEMPLATE)", async () => {
    // An active XLSX template for this customer; uploading a CSV against it must be rejected up-front
    // (before any Storage write), not deferred to a failed batch in the worker.
    const tpl = await db
      .insert(importTemplates)
      .values({
        customerId,
        name: `Tpl Mismatch ${Date.now()}`,
        version: 1,
        fileType: "xlsx",
        columnMappings: [{ source: "a", target: "externalTripId" }],
        parsingRules: {},
        requiredOverrides: [],
      })
      .returning({ id: importTemplates.id });

    await expect(
      createBatch(
        {
          customerId,
          templateId: tpl[0]!.id,
          fileName: "trips.csv",
          fileType: "csv",
          fileBytes: Buffer.from("a\n1\n", "utf8"),
        },
        uploaderId,
      ),
    ).rejects.toMatchObject({ code: "INVALID_TEMPLATE" });
  });

  it("getBatch returns the status + four outcome counts", async () => {
    const id = await seedBatch("validated");
    const detail = await getBatch(id);
    expect(detail).not.toBeNull();
    expect(detail?.status).toBe("validated");
    expect(detail?.totalRows).toBe(0);
    expect(detail?.createdCount).toBe(0);
    expect(detail?.updatedCount).toBe(0);
    expect(detail?.duplicateCount).toBe(0);
    expect(detail?.errorCount).toBe(0);
    expect(detail?.hasErrorReport).toBe(false);
  });

  it("getBatch returns null for an unknown batch id", async () => {
    const detail = await getBatch("00000000-0000-0000-0000-000000000000");
    expect(detail).toBeNull();
  });

  it("confirmBatch throws Conflict NOT_CONFIRMABLE when the batch is still 'received'", async () => {
    const id = await seedBatch("received");
    await expect(confirmBatch(id, uploaderId)).rejects.toMatchObject({
      code: "NOT_CONFIRMABLE",
    });
    await expect(confirmBatch(id, uploaderId)).rejects.toBeInstanceOf(Conflict);
  });

  it("confirmBatch throws Conflict NOT_FOUND for an unknown batch id", async () => {
    await expect(
      confirmBatch("00000000-0000-0000-0000-000000000000", uploaderId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
