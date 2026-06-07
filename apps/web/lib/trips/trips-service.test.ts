import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, customers, db, locations, tripEvents, trips, users } from "@brazil-tms/db";
import { createTrip, getTrip } from "./trips-service";

/**
 * Integration test against the live dev DB (US1). Static imports per project convention; the Drizzle
 * `db` connects lazily, so importing is safe. The suite skips when DATABASE_URL is unset so the
 * default `pnpm test` stays green. To run it:
 *   $env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'; pnpm exec vitest run --project web
 *
 * Focus: create snapshots the immutable `original_plan` + status `received` + one `trip.create`
 * audit (SC-002, SC-003); a non-status milestone event leaves the planned columns untouched and is
 * distinguishable from the planned windows (FR-006/FR-007/SC-006); the detail loader returns
 * events/audit/billingStatus.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("trips-service (integration)", () => {
  let actorId = "";
  let customerId = "";
  let originId = "";
  let destId = "";
  const createdTripIds: string[] = [];
  const createdLocationIds: string[] = [];
  const createdCustomerIds: string[] = [];

  function code(prefix = "TRIP-TEST"): string {
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
      .values({ name: "Cliente Viagens", customerCode: code("CUST") })
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
    // FK-safe order: trip_events + audit → trips → locations → customers.
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

  it("create stores original_plan + status received + exactly one trip.create audit", async () => {
    const pickupStart = new Date("2026-06-01T08:00:00.000Z");
    const detail = await createTrip(
      {
        customerId,
        externalTripId: code("EXT"),
        originLocationId: originId,
        destinationLocationId: destId,
        plannedPickupWindowStart: pickupStart,
        plannedVehicleType: "truck",
        plannedVolumeUnits: 12,
      },
      actorId,
    );
    createdTripIds.push(detail.id);

    expect(detail.currentStatus).toBe("received");
    expect(detail.billingStatus).toBeNull();
    expect(detail.plannedVehicleType).toBe("truck");
    expect(detail.plannedVolumeUnits).toBe(12);
    expect(detail.plannedPickupWindowStart).toBe(pickupStart.toISOString());

    // The immutable snapshot captured the create payload.
    const snapshot = detail.originalPlan as Record<string, unknown>;
    expect(snapshot.customerId).toBe(customerId);
    expect(snapshot.originLocationId).toBe(originId);
    expect(snapshot.destinationLocationId).toBe(destId);
    expect(snapshot.plannedVehicleType).toBe("truck");

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, detail.id), eq(auditLogs.action, "trip.create")));
    expect(audits).toHaveLength(1);
  });

  it("born-validated: createTrip(input, actor, 'validated') creates a validated trip + a validated trip.create audit (slice 014)", async () => {
    const detail = await createTrip(
      {
        customerId,
        externalTripId: code("EXT"),
        originLocationId: originId,
        destinationLocationId: destId,
      },
      actorId,
      "validated",
    );
    createdTripIds.push(detail.id);

    // The trip is born `validated` (the confirm-import path), not `received`.
    expect(detail.currentStatus).toBe("validated");

    // The single trip.create audit records the born status — `validated` — with no extra write (SC-003).
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, detail.id), eq(auditLogs.action, "trip.create")));
    expect(audits).toHaveLength(1);
    expect((audits[0]!.newValue as { currentStatus?: string }).currentStatus).toBe("validated");
  });

  it("a non-status milestone event leaves planned columns intact and is surfaced separately (FR-006/FR-007)", async () => {
    const plannedPickup = new Date("2026-06-02T09:00:00.000Z");
    const created = await createTrip(
      {
        customerId,
        externalTripId: code("EXT"),
        originLocationId: originId,
        destinationLocationId: destId,
        plannedPickupWindowStart: plannedPickup,
      },
      actorId,
    );
    createdTripIds.push(created.id);

    // The ACTUAL arrival is recorded as a trip_event — it must NOT overwrite the planned column (R6).
    const actualArrival = new Date("2026-06-02T09:42:00.000Z");
    await db.insert(tripEvents).values({
      tripId: created.id,
      eventType: "origin_arrived",
      source: "operator_manual",
      eventTimestamp: actualArrival,
      locationId: originId,
    });

    const detail = await getTrip(created.id);
    expect(detail).not.toBeNull();
    // Planned window is unchanged by the actual-arrival event.
    expect(detail!.plannedPickupWindowStart).toBe(plannedPickup.toISOString());

    const arrival = detail!.events.find((e) => e.eventType === "origin_arrived");
    expect(arrival).toBeDefined();
    expect(arrival!.statusBefore).toBeNull();
    expect(arrival!.statusAfter).toBeNull();
    expect(arrival!.eventTimestamp).toBe(actualArrival.toISOString());
    expect(arrival!.locationId).toBe(originId);
    // The executed milestone is distinct from the planned window value.
    expect(arrival!.eventTimestamp).not.toBe(detail!.plannedPickupWindowStart);
  });

  it("getTrip returns events, audit, and a null billingStatus for a received trip", async () => {
    const created = await createTrip(
      {
        customerId,
        externalTripId: code("EXT"),
        originLocationId: originId,
        destinationLocationId: destId,
      },
      actorId,
    );
    createdTripIds.push(created.id);

    const detail = await getTrip(created.id);
    expect(detail).not.toBeNull();
    expect(Array.isArray(detail!.events)).toBe(true);
    expect(Array.isArray(detail!.audit)).toBe(true);
    // The create audit is present; billing projection is null for a non-billing status.
    expect(detail!.audit.some((a) => a.action === "trip.create")).toBe(true);
    expect(detail!.billingStatus).toBeNull();
  });

  it("getTrip returns null for an unknown id", async () => {
    const missing = await getTrip("00000000-0000-0000-0000-000000000000");
    expect(missing).toBeNull();
  });
});
