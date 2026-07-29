import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, customers, db, locations, tripEvents, trips, users } from "@brazil-tms/db";
import { Conflict } from "@/lib/api/respond";
import { createTrip } from "./trips-service";
import { updateTripPlan } from "./trip-plan";

/**
 * Integration test against the live dev DB (US1). Static imports per project convention. Skips when
 * DATABASE_URL is unset. To run it:
 *   $env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'; pnpm exec vitest run --project web
 *
 * Focus: an accepted plan update edits the live `planned_*` column, leaves the immutable
 * `original_plan` intact (SC-002), and writes exactly one `trip.plan_update` audit covering the
 * changed critical field (FR-016); a post-`confirmed` edit without an authorized review is rejected
 * (FR-005, REVIEW_REQUIRED).
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("trip-plan updateTripPlan (integration)", () => {
  let actorId = "";
  let customerId = "";
  let originId = "";
  let destId = "";
  const createdTripIds: string[] = [];
  const createdLocationIds: string[] = [];
  const createdCustomerIds: string[] = [];

  function code(prefix = "PLAN-TEST"): string {
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
      .values({ name: "Cliente Plano", customerCode: code("CUST") })
      .returning();
    customerId = cust[0]!.id;
    createdCustomerIds.push(customerId);

    const origin = await db
      .insert(locations)
      .values({ customerId, code: code("ORIG"), name: "Origem" })
      .returning();
    originId = origin[0]!.id;
    createdLocationIds.push(originId);

    const dest = await db
      .insert(locations)
      .values({ customerId, code: code("DEST"), name: "Destino" })
      .returning();
    destId = dest[0]!.id;
    createdLocationIds.push(destId);
  });

  afterAll(async () => {
    for (const id of createdTripIds) {
      await db.delete(tripEvents).where(eq(tripEvents.tripId, id));
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(trips).where(eq(trips.id, id));
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

  async function makeTrip(): Promise<string> {
    const detail = await createTrip(
      {
        customerId,
        externalTripId: code("EXT"),
        originLocationId: originId,
        destinationLocationId: destId,
        plannedVehicleType: "truck",
      },
      actorId,
    );
    createdTripIds.push(detail.id);
    return detail.id;
  }

  it("an accepted critical update edits the live column, preserves original_plan, and writes one trip.plan_update audit", async () => {
    const tripId = await makeTrip();

    const before = await db.select().from(trips).where(eq(trips.id, tripId)).limit(1);
    const originalSnapshot = before[0]!.originalPlan;

    const updated = await updateTripPlan(
      tripId,
      { plannedVehicleType: "carreta" },
      {},
      actorId,
    );

    // Live column changed...
    expect(updated.plannedVehicleType).toBe("carreta");
    // ...but the immutable snapshot still reflects the original "truck" (SC-002).
    expect(updated.originalPlan).toStrictEqual(originalSnapshot);
    expect((updated.originalPlan as Record<string, unknown>).plannedVehicleType).toBe("truck");

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, tripId), eq(auditLogs.action, "trip.plan_update")));
    expect(audits).toHaveLength(1);
    expect((audits[0]!.previousValue as Record<string, unknown>).plannedVehicleType).toBe("truck");
    expect((audits[0]!.newValue as Record<string, unknown>).plannedVehicleType).toBe("carreta");
  });

  it("a non-critical-only update writes no plan_update audit", async () => {
    const tripId = await makeTrip();

    await updateTripPlan(tripId, { plannedRouteNotes: "Portão lateral." }, {}, actorId);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, tripId), eq(auditLogs.action, "trip.plan_update")));
    expect(audits).toHaveLength(0);
  });

  it("rejects a post-confirmed edit without authorizedReview (REVIEW_REQUIRED)", async () => {
    const tripId = await makeTrip();
    // Drive the trip past `confirmed` directly for this gate test.
    await db.update(trips).set({ currentStatus: "at_origin" }).where(eq(trips.id, tripId));

    await expect(
      updateTripPlan(tripId, { plannedVehicleType: "van" }, {}, actorId),
    ).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });

    // With the authorized-review flag, the same edit is accepted.
    const updated = await updateTripPlan(
      tripId,
      { plannedVehicleType: "van" },
      { authorizedReview: true },
      actorId,
    );
    expect(updated.plannedVehicleType).toBe("van");
  });

  it("serializes concurrent same-field updates so audit previous-values are never stale (P2)", async () => {
    const tripId = await makeTrip(); // plannedVehicleType starts "truck"

    // Two updates to the SAME critical field, fired together. The per-row lock forces them to
    // serialize, so the second reads the first's committed value — the audit previous-values form a
    // proper chain (distinct), not two stale reads of the original "truck" (the pre-fix race).
    await Promise.all([
      updateTripPlan(tripId, { plannedVehicleType: "carreta" }, {}, actorId),
      updateTripPlan(tripId, { plannedVehicleType: "van" }, {}, actorId),
    ]);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, tripId), eq(auditLogs.action, "trip.plan_update")));
    expect(audits).toHaveLength(2);
    const prevs = audits.map(
      (a) => (a.previousValue as Record<string, unknown>).plannedVehicleType,
    );
    expect(new Set(prevs).size).toBe(2);
    expect(prevs).toContain("truck");
  });

  it("rejects a PARTIAL edit that inverts the merged pickup window (INVALID_PLAN_WINDOW)", async () => {
    const start = new Date("2026-06-01T12:00:00.000Z");
    const detail = await createTrip(
      {
        customerId,
        externalTripId: code("EXT"),
        originLocationId: originId,
        destinationLocationId: destId,
        plannedPickupWindowStart: start,
      },
      actorId,
    );
    createdTripIds.push(detail.id);

    // Send ONLY the end, earlier than the existing (untouched) start → the merged window is invalid.
    await expect(
      updateTripPlan(
        detail.id,
        { plannedPickupWindowEnd: new Date("2026-06-01T08:00:00.000Z") },
        {},
        actorId,
      ),
    ).rejects.toMatchObject({ code: "INVALID_PLAN_WINDOW" });

    // A valid end (after the start) is accepted.
    const ok = await updateTripPlan(
      detail.id,
      { plannedPickupWindowEnd: new Date("2026-06-01T15:00:00.000Z") },
      {},
      actorId,
    );
    expect(ok.plannedPickupWindowEnd).toBe("2026-06-01T15:00:00.000Z");
  });

  it("update of a missing trip throws NOT_FOUND", async () => {
    await expect(
      updateTripPlan(
        "00000000-0000-0000-0000-000000000000",
        { plannedVehicleType: "van" },
        {},
        actorId,
      ),
    ).rejects.toBeInstanceOf(Conflict);
  });
});
