import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, customers, db, locations, tripEvents, trips, users } from "@brazil-tms/db";
import { createTrip } from "./trips-service";
import { updateTripPlan } from "./trip-plan";
import { transitionTripStatus } from "./trip-transitions";

/**
 * US3 (T026) — the cross-cutting audit guarantee the services already implement: every critical-field
 * change and lifecycle action writes EXACTLY ONE immutable audit row, and a non-critical change writes
 * none (TRIP-007; FR-015..FR-018; SC-003). Verification phase over the US1/US2 services — no new code.
 * Integration test against the live dev DB; skips when DATABASE_URL is unset.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("trip audit semantics (integration, US3)", () => {
  let actorId = "";
  let customerId = "";
  let originId = "";
  let destId = "";
  const createdTripIds: string[] = [];

  function code(prefix = "AUDIT-TEST"): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  async function newTrip(): Promise<string> {
    const t = await createTrip(
      { customerId, originLocationId: originId, destinationLocationId: destId },
      actorId,
    );
    createdTripIds.push(t.id);
    return t.id;
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
      .values({ name: "Cliente Auditoria", customerCode: code("CUST") })
      .returning();
    customerId = cust[0]!.id;

    const origin = await db
      .insert(locations)
      .values({ customerId, code: code("ORIG"), name: "Origem Aud" })
      .returning();
    originId = origin[0]!.id;

    const dest = await db
      .insert(locations)
      .values({ customerId, code: code("DEST"), name: "Destino Aud" })
      .returning();
    destId = dest[0]!.id;
  });

  afterAll(async () => {
    for (const id of createdTripIds) {
      await db.delete(tripEvents).where(eq(tripEvents.tripId, id));
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(trips).where(eq(trips.id, id));
    }
    for (const id of [originId, destId]) {
      if (id) await db.delete(locations).where(eq(locations.id, id));
    }
    if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
  });

  it("create writes exactly one trip.create audit row", async () => {
    const id = await newTrip();
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "trip.create")));
    expect(audits).toHaveLength(1);
  });

  it("a critical-field change writes exactly one trip.plan_update with before/after/actor/timestamp", async () => {
    const id = await newTrip();
    await updateTripPlan(id, { plannedVehicleType: "carreta" }, {}, actorId);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "trip.plan_update")));
    expect(audits).toHaveLength(1);
    const a = audits[0]!;
    expect(a.previousValue).toMatchObject({ plannedVehicleType: null });
    expect(a.newValue).toMatchObject({ plannedVehicleType: "carreta" });
    expect(a.actorUserId).toBe(actorId);
    expect(a.createdAt).toBeInstanceOf(Date);
  });

  it("a non-critical field change writes NO critical-change (trip.plan_update) audit row", async () => {
    const id = await newTrip();
    await updateTripPlan(id, { plannedRouteNotes: "via BR-101" }, {}, actorId);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "trip.plan_update")));
    expect(audits).toHaveLength(0);
  });

  it("a status change writes exactly one trip.status_change audit row", async () => {
    const id = await newTrip();
    await transitionTripStatus(id, { toStatus: "assigned", expectedFromStatus: "received" }, actorId);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "trip.status_change")));
    expect(audits).toHaveLength(1);
  });
});
