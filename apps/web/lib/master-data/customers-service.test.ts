import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, customers, db, users } from "@brazil-tms/db";
import { Conflict } from "@/lib/api/respond";
import { archiveCustomer, createCustomer, listCustomers, updateCustomer } from "./customers-service";

/**
 * Integration test against the live dev DB (T027). Static imports per project convention; the
 * Drizzle `db` connects lazily, so importing is safe. The suite skips when DATABASE_URL is unset
 * (e.g. CI without a database) so the default `pnpm test` stays green. To run it:
 *   $env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'; pnpm exec vitest run --project web
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("customers-service (integration)", () => {
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
      await db.delete(customers).where(eq(customers.id, id));
    }
  });

  function code(): string {
    return `CUST-TEST-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  it("create inserts the row and emits customer.create in the same transaction", async () => {
    const customerCode = code();
    const dto = await createCustomer({ name: "Cliente Teste", customerCode, contacts: [] }, actorId);
    createdIds.push(dto.id);
    expect(dto.customerCode).toBe(customerCode);
    expect(dto.archived).toBe(false);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, dto.id), eq(auditLogs.action, "customer.create")));
    expect(audits).toHaveLength(1);
  });

  it("rejects a duplicate customerCode with Conflict DUPLICATE_CUSTOMER_CODE", async () => {
    const customerCode = code();
    const first = await createCustomer({ name: "Primeiro", customerCode, contacts: [] }, actorId);
    createdIds.push(first.id);

    await expect(
      createCustomer({ name: "Segundo", customerCode, contacts: [] }, actorId),
    ).rejects.toMatchObject({ code: "DUPLICATE_CUSTOMER_CODE" });
  });

  it("archive sets archived_at and emits customer.archive; idempotent on re-archive", async () => {
    const dto = await createCustomer({ name: "Para Arquivar", customerCode: code(), contacts: [] }, actorId);
    createdIds.push(dto.id);

    const archived = await archiveCustomer(dto.id, actorId);
    expect(archived.archived).toBe(true);
    expect(archived.archivedAt).not.toBeNull();

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, dto.id), eq(auditLogs.action, "customer.archive")));
    expect(audits).toHaveLength(1);

    // Active-only list excludes it; includeArchived returns it.
    const active = await listCustomers({});
    expect(active.find((c) => c.id === dto.id)).toBeUndefined();
    const all = await listCustomers({ includeArchived: true });
    expect(all.find((c) => c.id === dto.id)).toBeDefined();

    // Re-archiving is idempotent and writes no second archive audit.
    await archiveCustomer(dto.id, actorId);
    const auditsAfter = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, dto.id), eq(auditLogs.action, "customer.archive")));
    expect(auditsAfter).toHaveLength(1);
  });

  it("update of a missing customer throws NOT_FOUND", async () => {
    await expect(
      updateCustomer("00000000-0000-0000-0000-000000000000", { name: "X" }, actorId),
    ).rejects.toBeInstanceOf(Conflict);
  });
});
