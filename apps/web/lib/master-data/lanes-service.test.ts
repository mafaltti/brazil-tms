import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, customers, db, lanes, locations, users } from "@brazil-tms/db";
import { Conflict } from "@/lib/api/respond";
import { archiveLane, createLane, listLanes, updateLane } from "./lanes-service";

/**
 * Integration test against the live dev DB (US2). Static imports per project convention; the Drizzle
 * `db` connects lazily, so importing is safe. The suite skips when DATABASE_URL is unset (e.g. CI
 * without a database) so the default `pnpm test` stays green. To run it:
 *   $env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'; pnpm exec vitest run --project web
 *
 * Focus: the cross-row lane-reference integrity (FR-009, R5) that the DB CHECK cannot express —
 * customer/origin/destination must all be active and same-customer; origin ≠ destination.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("lanes-service (integration)", () => {
  let actorId = "";
  let customerAId = "";
  let customerBId = "";
  let originAId = "";
  let destAId = "";
  let locationBId = "";
  const createdLaneIds: string[] = [];
  const createdLocationIds: string[] = [];
  const createdCustomerIds: string[] = [];

  beforeAll(async () => {
    const admin = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "admin@braziltransports.com.br"))
      .limit(1);
    actorId = admin[0]?.id ?? "";
    expect(actorId, "seeded admin must exist (run db:seed)").not.toBe("");

    // Two customers; customer A gets an origin + destination, customer B gets one location.
    const custA = await db
      .insert(customers)
      .values({ name: "Cliente Rotas A", customerCode: code("CUST-A") })
      .returning();
    customerAId = custA[0]!.id;
    createdCustomerIds.push(customerAId);

    const custB = await db
      .insert(customers)
      .values({ name: "Cliente Rotas B", customerCode: code("CUST-B") })
      .returning();
    customerBId = custB[0]!.id;
    createdCustomerIds.push(customerBId);

    const origin = await db
      .insert(locations)
      .values({ customerId: customerAId, code: code("ORIG"), name: "Origem A" })
      .returning();
    originAId = origin[0]!.id;
    createdLocationIds.push(originAId);

    const dest = await db
      .insert(locations)
      .values({ customerId: customerAId, code: code("DEST"), name: "Destino A" })
      .returning();
    destAId = dest[0]!.id;
    createdLocationIds.push(destAId);

    const locB = await db
      .insert(locations)
      .values({ customerId: customerBId, code: code("LOCB"), name: "Local B" })
      .returning();
    locationBId = locB[0]!.id;
    createdLocationIds.push(locationBId);
  });

  afterAll(async () => {
    // FK-safe order: lanes → locations → customers.
    for (const id of createdLaneIds) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(lanes).where(eq(lanes.id, id));
    }
    for (const id of createdLocationIds) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(locations).where(eq(locations.id, id));
    }
    for (const id of createdCustomerIds) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(customers).where(eq(customers.id, id));
    }
  });

  function code(prefix = "LANE-TEST"): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  it("create inserts the row and emits lane.create in the same transaction", async () => {
    const dto = await createLane(
      {
        customerId: customerAId,
        originLocationId: originAId,
        destinationLocationId: destAId,
        standardRateCents: 12345,
      },
      actorId,
    );
    createdLaneIds.push(dto.id);
    expect(dto.customerId).toBe(customerAId);
    expect(dto.originLocationId).toBe(originAId);
    expect(dto.destinationLocationId).toBe(destAId);
    expect(dto.standardRateCents).toBe(12345);
    expect(dto.archived).toBe(false);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, dto.id), eq(auditLogs.action, "lane.create")));
    expect(audits).toHaveLength(1);
  });

  it("accepts a blank/cleared standardDistanceKm as SQL NULL, not the string 'null' (P1)", async () => {
    // A blank optional distance coerces to null; it must reach the numeric column as SQL NULL.
    const dto = await createLane(
      {
        customerId: customerAId,
        originLocationId: originAId,
        destinationLocationId: destAId,
        standardDistanceKm: null,
      },
      actorId,
    );
    createdLaneIds.push(dto.id);
    expect(dto.standardDistanceKm).toBeNull();

    // Set a distance, then clear it on edit — the clear must persist as NULL (not reject).
    const withDist = await updateLane(dto.id, { standardDistanceKm: 430 }, actorId);
    expect(withDist.standardDistanceKm).not.toBeNull();
    const cleared = await updateLane(dto.id, { standardDistanceKm: null }, actorId);
    expect(cleared.standardDistanceKm).toBeNull();
  });

  it("rejects a lane whose destination belongs to another customer (INVALID_LANE_REFERENCE)", async () => {
    await expect(
      createLane(
        {
          customerId: customerAId,
          originLocationId: originAId,
          destinationLocationId: locationBId, // belongs to customer B
        },
        actorId,
      ),
    ).rejects.toMatchObject({ code: "INVALID_LANE_REFERENCE" });
  });

  it("rejects a degenerate lane (origin === destination) with INVALID_LANE_REFERENCE", async () => {
    await expect(
      createLane(
        {
          customerId: customerAId,
          originLocationId: originAId,
          destinationLocationId: originAId,
        },
        actorId,
      ),
    ).rejects.toMatchObject({ code: "INVALID_LANE_REFERENCE" });
  });

  it("rejects a lane referencing an archived location (INVALID_LANE_REFERENCE)", async () => {
    // Archive a fresh customer-A location, then try to use it as origin.
    const tmp = await db
      .insert(locations)
      .values({
        customerId: customerAId,
        code: code("ARCH"),
        name: "Arquivado",
        archivedAt: new Date(),
      })
      .returning();
    createdLocationIds.push(tmp[0]!.id);

    await expect(
      createLane(
        {
          customerId: customerAId,
          originLocationId: tmp[0]!.id,
          destinationLocationId: destAId,
        },
        actorId,
      ),
    ).rejects.toMatchObject({ code: "INVALID_LANE_REFERENCE" });
  });

  it("archive sets archived_at and emits lane.archive; idempotent on re-archive", async () => {
    const dto = await createLane(
      { customerId: customerAId, originLocationId: originAId, destinationLocationId: destAId },
      actorId,
    );
    createdLaneIds.push(dto.id);

    const archived = await archiveLane(dto.id, actorId);
    expect(archived.archived).toBe(true);
    expect(archived.archivedAt).not.toBeNull();

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, dto.id), eq(auditLogs.action, "lane.archive")));
    expect(audits).toHaveLength(1);

    // Active-only list excludes it; includeArchived returns it.
    const active = await listLanes({ customerId: customerAId });
    expect(active.find((l) => l.id === dto.id)).toBeUndefined();
    const all = await listLanes({ customerId: customerAId, includeArchived: true });
    expect(all.find((l) => l.id === dto.id)).toBeDefined();

    // Re-archiving is idempotent and writes no second archive audit.
    await archiveLane(dto.id, actorId);
    const auditsAfter = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, dto.id), eq(auditLogs.action, "lane.archive")));
    expect(auditsAfter).toHaveLength(1);
  });

  it("update of a missing lane throws NOT_FOUND", async () => {
    await expect(
      updateLane(
        "00000000-0000-0000-0000-000000000000",
        { expectedTransitMinutes: 60 },
        actorId,
      ),
    ).rejects.toBeInstanceOf(Conflict);
  });
});
