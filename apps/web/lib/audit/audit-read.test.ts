import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { auditLogs, db, queryAuditLog, users } from "@brazil-tms/db";

/**
 * Feature 009 US4 — `queryAuditLog` integration (data-model §5). Seeds append-only `audit_logs` rows
 * for two actors across a date range, then asserts the new `actorUserId`/`from`/`to`/`limit`/`offset`
 * filters, the `actorName` (users) join, and the `{ items, total }` shape. Static imports + skipIf per
 * MEMORY. (The test connects as the `postgres` superuser, which can clean up the append-only table.)
 */

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("queryAuditLog (integration, US4)", () => {
  let adminId = "";
  let financeId = "";
  // Unique entity ids so filters isolate exactly the rows this test inserts.
  const E1 = crypto.randomUUID();
  const E2 = crypto.randomUUID();

  const base = { limit: 50 as number, offset: 0 as number };

  beforeAll(async () => {
    const admin = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "admin@braziltransports.com.br"))
      .limit(1);
    adminId = admin[0]?.id ?? "";
    const finance = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "finance@braziltransports.com.br"))
      .limit(1);
    financeId = finance[0]?.id ?? "";
    expect(adminId, "seeded admin must exist (run db:seed)").not.toBe("");
    expect(financeId, "seeded finance must exist (run db:seed:e2e)").not.toBe("");

    await db.insert(auditLogs).values([
      {
        entityType: "trip",
        entityId: E1,
        action: "trip.status_change",
        actorUserId: adminId,
        createdAt: new Date("2026-05-10T10:00:00.000Z"),
        newValue: { currentStatus: "in_transit" },
      },
      {
        entityType: "trip",
        entityId: E1,
        action: "trip.plan_update",
        actorUserId: financeId,
        createdAt: new Date("2026-05-15T10:00:00.000Z"),
      },
      {
        entityType: "document",
        entityId: E2,
        action: "document.verify",
        actorUserId: adminId,
        createdAt: new Date("2026-04-01T10:00:00.000Z"),
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, [E1, E2]));
  });

  it("returns { items, total } newest-first with the actor-name join", async () => {
    const page = await queryAuditLog({ ...base, entityId: E1 });
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(2);
    // newest-first: the May-15 plan_update precedes the May-10 status_change.
    expect(page.items[0]!.action).toBe("trip.plan_update");
    expect(page.items[1]!.action).toBe("trip.status_change");
    expect(page.items.every((e) => typeof e.actorName === "string" && e.actorName.length > 0)).toBe(
      true,
    );
  });

  it("honors the actorUserId filter", async () => {
    const adminOnly = await queryAuditLog({ ...base, entityId: E1, actorUserId: adminId });
    expect(adminOnly.total).toBe(1);
    expect(adminOnly.items[0]!.action).toBe("trip.status_change");

    const financeOnly = await queryAuditLog({ ...base, entityId: E1, actorUserId: financeId });
    expect(financeOnly.total).toBe(1);
    expect(financeOnly.items[0]!.action).toBe("trip.plan_update");
  });

  it("honors the from/to date range (São Paulo calendar days, `to` inclusive)", async () => {
    // from 2026-05-12 (BRT) → excludes the May-10 row, includes the May-15 row.
    const afterMay12 = await queryAuditLog({ ...base, entityId: E1, from: "2026-05-12" });
    expect(afterMay12.total).toBe(1);
    expect(afterMay12.items[0]!.action).toBe("trip.plan_update");

    // The whole month includes both May rows; `to` of the last day is inclusive of that day.
    const wholeMonth = await queryAuditLog({ ...base, entityId: E1, from: "2026-05-01", to: "2026-05-31" });
    expect(wholeMonth.total).toBe(2);

    // A `to` on the same day as a record still includes it (the date-only boundary bug fix).
    const upToMay15 = await queryAuditLog({ ...base, entityId: E1, to: "2026-05-15" });
    expect(upToMay15.total).toBe(2);
  });

  it("honors limit/offset pagination while reporting the full total", async () => {
    const firstPage = await queryAuditLog({ entityId: E1, limit: 1, offset: 0 });
    expect(firstPage.total).toBe(2);
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.items[0]!.action).toBe("trip.plan_update");

    const secondPage = await queryAuditLog({ entityId: E1, limit: 1, offset: 1 });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]!.action).toBe("trip.status_change");
  });
});
