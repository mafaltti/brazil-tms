import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  Conflict,
  auditLogs,
  customers,
  db,
  importBatches,
  importRows,
  locationAliases,
  locations,
  users,
} from "@brazil-tms/db";
import { resolveLocation } from "./location-aliases-service";

/**
 * Integration test against the live dev DB (T051, US4). Static imports per project convention; the
 * Drizzle `db` connects lazily, so importing is safe. The suite skips when DATABASE_URL is unset so
 * the default `pnpm test` stays green. To run it:
 *   $env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'; pnpm exec vitest run --project web
 *
 * Focus: `resolveLocation` maps a flagged `unknown_location` row's file value to an EXISTING active
 * location, inserts the `(customer_id, file_value)` alias, and audits `location_alias.create`; a target
 * that is archived or of another customer is rejected with `INVALID_LOCATION_REFERENCE`. We assert the
 * DB/audit effects only — the worker is NOT run (resolveLocation enqueues a `validate` job; that just
 * sends and is harmless here).
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("location-aliases-service (integration)", () => {
  let actorId = "";
  let customerId = "";
  let otherCustomerId = "";
  let activeLocationId = "";
  let archivedLocationId = "";
  let otherCustomerLocationId = "";
  let batchId = "";
  const createdAliasIds: string[] = [];
  const createdRowIds: string[] = [];

  function code(prefix = "ALIAS-TEST"): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  beforeAll(async () => {
    // Reuse the seeded admin as actor — `users`/`created_by` FK to auth.users, so we cannot mint a
    // fresh user row directly (same approach as the 002/003/004 service tests).
    const admin = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "admin@braziltransports.com.br"))
      .limit(1);
    actorId = admin[0]?.id ?? "";
    expect(actorId, "seeded admin must exist (run db:seed)").not.toBe("");

    const cust = await db
      .insert(customers)
      .values({ name: "Cliente Alias", customerCode: code("CUST") })
      .returning({ id: customers.id });
    customerId = cust[0]!.id;

    const other = await db
      .insert(customers)
      .values({ name: "Cliente Alias Outro", customerCode: code("CUST2") })
      .returning({ id: customers.id });
    otherCustomerId = other[0]!.id;

    // An active location of the batch's customer (the valid mapping target).
    const active = await db
      .insert(locations)
      .values({ customerId, code: code("LOC"), name: "Centro de Distribuição" })
      .returning({ id: locations.id });
    activeLocationId = active[0]!.id;

    // An archived location of the same customer (must be rejected).
    const archived = await db
      .insert(locations)
      .values({
        customerId,
        code: code("LOC-ARC"),
        name: "Local Arquivado",
        archivedAt: new Date(),
      })
      .returning({ id: locations.id });
    archivedLocationId = archived[0]!.id;

    // An active location of ANOTHER customer (must be rejected).
    const foreign = await db
      .insert(locations)
      .values({ customerId: otherCustomerId, code: code("LOC-X"), name: "Local de Outro Cliente" })
      .returning({ id: locations.id });
    otherCustomerLocationId = foreign[0]!.id;

    // A batch for this customer, with one row flagged unknown_location.
    batchId = crypto.randomUUID();
    await db.insert(importBatches).values({
      id: batchId,
      customerId,
      fileName: "seed.csv",
      storageKey: `originals/${batchId}`,
      uploadedBy: actorId,
      status: "validated",
    });
    const row = await db
      .insert(importRows)
      .values({
        importBatchId: batchId,
        rowNumber: 1,
        raw: { origin: "DEPOSITO SP" },
        outcome: "error",
        reasons: [{ code: "unknown_location", field: "origin", message: "Local desconhecido." }],
      })
      .returning({ id: importRows.id });
    createdRowIds.push(row[0]!.id);
  });

  afterAll(async () => {
    // FK-safe order: aliases + rows + their audit → batch → locations → customers.
    for (const id of createdAliasIds) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(locationAliases).where(eq(locationAliases.id, id));
    }
    for (const id of createdRowIds) {
      await db.delete(importRows).where(eq(importRows.id, id));
    }
    if (batchId) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, batchId));
      await db.delete(importBatches).where(eq(importBatches.id, batchId));
    }
    for (const id of [activeLocationId, archivedLocationId, otherCustomerLocationId]) {
      if (id) await db.delete(locations).where(eq(locations.id, id));
    }
    for (const id of [customerId, otherCustomerId]) {
      if (id) await db.delete(customers).where(eq(customers.id, id));
    }
  });

  it("maps a file value to an existing location, inserts the alias, and audits location_alias.create", async () => {
    const fileValue = `DEPOSITO SP ${Date.now()}`;
    const result = await resolveLocation(
      batchId,
      { fileValue, locationId: activeLocationId },
      actorId,
    );
    createdAliasIds.push(result.id);

    const aliasRows = await db
      .select()
      .from(locationAliases)
      .where(
        and(
          eq(locationAliases.customerId, customerId),
          eq(locationAliases.fileValue, fileValue),
        ),
      );
    expect(aliasRows).toHaveLength(1);
    expect(aliasRows[0]?.id).toBe(result.id);
    expect(aliasRows[0]?.locationId).toBe(activeLocationId);
    expect(aliasRows[0]?.createdBy).toBe(actorId);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityId, result.id),
          eq(auditLogs.action, "location_alias.create"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.entityType).toBe("location_alias");
  });

  it("rejects an archived location with Conflict INVALID_LOCATION_REFERENCE", async () => {
    await expect(
      resolveLocation(
        batchId,
        { fileValue: code("FV-ARC"), locationId: archivedLocationId },
        actorId,
      ),
    ).rejects.toMatchObject({ code: "INVALID_LOCATION_REFERENCE" });
  });

  it("rejects a location of another customer with Conflict INVALID_LOCATION_REFERENCE", async () => {
    await expect(
      resolveLocation(
        batchId,
        { fileValue: code("FV-X"), locationId: otherCustomerLocationId },
        actorId,
      ),
    ).rejects.toBeInstanceOf(Conflict);
    await expect(
      resolveLocation(
        batchId,
        { fileValue: code("FV-X2"), locationId: otherCustomerLocationId },
        actorId,
      ),
    ).rejects.toMatchObject({ code: "INVALID_LOCATION_REFERENCE" });
  });

  it("throws Conflict NOT_FOUND for an unknown batch id", async () => {
    await expect(
      resolveLocation(
        "00000000-0000-0000-0000-000000000000",
        { fileValue: code("FV-NB"), locationId: activeLocationId },
        actorId,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
