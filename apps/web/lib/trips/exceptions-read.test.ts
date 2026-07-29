import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  alerts,
  auditLogs,
  createException,
  customers,
  db,
  exceptions,
  lanes,
  locations,
  queryExceptions,
  queryReasonCodes,
  reasonCodes,
  trips,
  users,
} from "@brazil-tms/db";

/**
 * Feature 007 US2 — Exception Management read-model integration test (live dev DB). Verifies the
 * `queryExceptions` filters (severity / customer-via-trip / lane-via-trip / reason / owner / age =
 * opened_at) and the derived category join through reason_code_id, plus `queryReasonCodes` returning
 * active rows ordered by sort_order. Uses the seeded admin as actor/owner. FK-safe cleanup.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("exceptions-read (integration)", () => {
  let actorId = "";
  let customerId = "";
  let originId = "";
  let destId = "";
  let laneId = "";
  let reasonId = "";
  let tripId = "";

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
    expect(actorId, "seeded admin must exist").not.toBe("");

    const cust = await db.insert(customers).values({ name: "Cliente ExcRead", customerCode: code("CUST") }).returning();
    customerId = cust[0]!.id;
    const origin = await db.insert(locations).values({ customerId, code: code("ORIG"), name: "Origem" }).returning();
    originId = origin[0]!.id;
    const dest = await db.insert(locations).values({ customerId, code: code("DEST"), name: "Destino" }).returning();
    destId = dest[0]!.id;
    const lane = await db
      .insert(lanes)
      .values({ customerId, originLocationId: originId, destinationLocationId: destId })
      .returning();
    laneId = lane[0]!.id;

    const rc = await db
      .insert(reasonCodes)
      .values({ code: code("RC"), category: "accident", labelPt: "Acidente", defaultSeverity: "high", defaultResponsibleParty: "force_majeure", sortOrder: 999 })
      .returning();
    reasonId = rc[0]!.id;

    const trip = await db
      .insert(trips)
      .values({ customerId, laneId, originLocationId: originId, destinationLocationId: destId, originalPlan: {}, currentStatus: "confirmed" })
      .returning();
    tripId = trip[0]!.id;

    await createException(tripId, { reasonCodeId: reasonId, description: "Para leitura." }, actorId);
  });

  afterAll(async () => {
    // The seeded reason code is high-severity ⇒ createException raised an alert; clear it before trips.
    await db.delete(alerts).where(eq(alerts.tripId, tripId));
    await db.delete(exceptions).where(eq(exceptions.tripId, tripId));
    await db.delete(auditLogs).where(eq(auditLogs.entityId, tripId));
    await db.delete(trips).where(eq(trips.id, tripId));
    await db.delete(lanes).where(eq(lanes.id, laneId));
    await db.delete(reasonCodes).where(eq(reasonCodes.id, reasonId));
    await db.delete(locations).where(inArray(locations.id, [originId, destId]));
    await db.delete(customers).where(eq(customers.id, customerId));
  });

  const baseFilter = { limit: 50, offset: 0 } as const;

  it("filters by severity and derives the category through the reason-code join", async () => {
    const rows = await queryExceptions({ ...baseFilter, severity: "high", customerId });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const mine = rows.find((r) => r.reasonCodeId === reasonId)!;
    expect(mine).toBeTruthy();
    expect(mine.category).toBe("accident"); // DERIVED join through reason_code_id
    expect(mine.severity).toBe("high");
    expect(mine.customerId).toBe(customerId);
  });

  it("filters by customer / lane / reason / owner", async () => {
    expect((await queryExceptions({ ...baseFilter, customerId })).some((r) => r.tripId === tripId)).toBe(true);
    expect((await queryExceptions({ ...baseFilter, laneId })).some((r) => r.tripId === tripId)).toBe(true);
    expect((await queryExceptions({ ...baseFilter, reasonCodeId: reasonId })).some((r) => r.tripId === tripId)).toBe(true);
    expect((await queryExceptions({ ...baseFilter, ownerUserId: actorId })).some((r) => r.tripId === tripId)).toBe(true);
  });

  it("the age filter (minAgeHours) excludes a just-opened exception", async () => {
    // Opened ~now ⇒ a 24h-minimum-age filter must not return it.
    const rows = await queryExceptions({ ...baseFilter, customerId, minAgeHours: 24 });
    expect(rows.some((r) => r.tripId === tripId)).toBe(false);
  });

  it("queryReasonCodes returns active rows ordered by sort_order", async () => {
    const rows = await queryReasonCodes();
    expect(rows.some((r) => r.id === reasonId)).toBe(true);
    const sorts = rows.map((r) => r.sortOrder);
    expect(sorts).toEqual([...sorts].sort((a, b) => a - b));
  });
});
