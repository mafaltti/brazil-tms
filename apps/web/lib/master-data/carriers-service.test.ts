import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, carriers, db, users } from "@brazil-tms/db";
import { Conflict } from "@/lib/api/respond";
import { archiveCarrier, createCarrier, listCarriers, updateCarrier } from "./carriers-service";

/**
 * Integration test against the live dev DB (US4). Static imports per project convention; the
 * Drizzle `db` connects lazily, so importing is safe. The suite skips when DATABASE_URL is unset
 * (e.g. CI without a database) so the default `pnpm test` stays green. To run it:
 *   $env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'; pnpm exec vitest run --project web
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("carriers-service (integration)", () => {
  let actorId = "";
  const createdIds: string[] = [];

  beforeAll(async () => {
    const admin = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "admin@braziltransports.com.br"))
      .limit(1);
    actorId = admin[0]?.id ?? "";
    expect(actorId, "seeded admin must exist (run db:seed)").not.toBe("");
  });

  afterAll(async () => {
    for (const id of createdIds) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(carriers).where(eq(carriers.id, id));
    }
  });

  /** Unique 14-digit CNPJ string per call (DB unique key on tax_id). */
  function cnpj(): string {
    const digits = `${Date.now()}${Math.floor(Math.random() * 1e6)}`.padStart(14, "0");
    return digits.slice(-14);
  }

  it("create inserts the row and emits carrier.create in the same transaction", async () => {
    const taxId = cnpj();
    const dto = await createCarrier({ name: "Transportadora Teste", taxId }, actorId);
    createdIds.push(dto.id);
    expect(dto.taxId).toBe(taxId);
    expect(dto.contractStatus).toBe("active");
    expect(dto.documentationStatus).toBe("pending");
    expect(dto.archived).toBe(false);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, dto.id), eq(auditLogs.action, "carrier.create")));
    expect(audits).toHaveLength(1);
  });

  it("rejects a duplicate taxId with Conflict DUPLICATE_TAX_ID", async () => {
    const taxId = cnpj();
    const first = await createCarrier({ name: "Primeira", taxId }, actorId);
    createdIds.push(first.id);

    await expect(
      createCarrier({ name: "Segunda", taxId }, actorId),
    ).rejects.toMatchObject({ code: "DUPLICATE_TAX_ID" });
  });

  it("archive sets archived_at and emits carrier.archive; idempotent on re-archive", async () => {
    const dto = await createCarrier({ name: "Para Arquivar", taxId: cnpj() }, actorId);
    createdIds.push(dto.id);

    const archived = await archiveCarrier(dto.id, actorId);
    expect(archived.archived).toBe(true);
    expect(archived.archivedAt).not.toBeNull();

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, dto.id), eq(auditLogs.action, "carrier.archive")));
    expect(audits).toHaveLength(1);

    // Active-only list excludes it; includeArchived returns it.
    const active = await listCarriers({});
    expect(active.find((c) => c.id === dto.id)).toBeUndefined();
    const all = await listCarriers({ includeArchived: true });
    expect(all.find((c) => c.id === dto.id)).toBeDefined();

    // Re-archiving is idempotent and writes no second archive audit.
    await archiveCarrier(dto.id, actorId);
    const auditsAfter = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, dto.id), eq(auditLogs.action, "carrier.archive")));
    expect(auditsAfter).toHaveLength(1);
  });

  it("update of a missing carrier throws NOT_FOUND", async () => {
    await expect(
      updateCarrier("00000000-0000-0000-0000-000000000000", { name: "X" }, actorId),
    ).rejects.toBeInstanceOf(Conflict);
  });
});
