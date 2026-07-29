import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, customers, db, locations, tripEvents, trips, users } from "@brazil-tms/db";
import { createOrUpdateTripManually } from "./manual-create";

/**
 * Integration test against the live dev DB (T056, US6). Static imports per project convention; the
 * Drizzle `db` connects lazily, so importing is safe. The suite skips when DATABASE_URL is unset so
 * the default `pnpm test` stays green. To run it:
 *   $env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'; pnpm exec vitest run --project web
 *
 * Focus: a manual create yields a trip in `received` with `import_batch_id` NULL + a `trip.create`
 * audit; re-running with the SAME `(customer, externalTripId)` and a changed plan field UPDATES the
 * existing trip (no duplicate — exactly one trip for that external id), matching the import-confirm
 * semantics. Reuses the seeded admin as actor (`users` FKs to auth.users); seeds a fresh customer +
 * two locations per run.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("manual-create (integration)", () => {
  let actorId = "";
  let customerId = "";
  let originId = "";
  let destId = "";
  const createdTripIds: string[] = [];
  const createdLocationIds: string[] = [];

  function code(prefix = "MANUAL-TEST"): string {
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
      .values({ name: "Cliente Manual", customerCode: code("CUST") })
      .returning({ id: customers.id });
    customerId = cust[0]!.id;

    const origin = await db
      .insert(locations)
      .values({ customerId, code: code("ORIG"), name: "Origem" })
      .returning({ id: locations.id });
    originId = origin[0]!.id;
    createdLocationIds.push(originId);

    const dest = await db
      .insert(locations)
      .values({ customerId, code: code("DEST"), name: "Destino" })
      .returning({ id: locations.id });
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
      await db.delete(locations).where(eq(locations.id, id));
    }
    if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
  });

  it("creates a received trip with import_batch_id NULL + a trip.create audit", async () => {
    const externalTripId = code("EXT");
    const { item, updated } = await createOrUpdateTripManually(
      {
        customerId,
        externalTripId,
        originLocationId: originId,
        destinationLocationId: destId,
        plannedVolumeUnits: 5,
      },
      actorId,
    );
    createdTripIds.push(item.id);

    expect(updated).toBe(false);
    expect(item.currentStatus).toBe("received");
    expect(item.customerId).toBe(customerId);
    expect(item.externalTripId).toBe(externalTripId);

    const rows = await db.select().from(trips).where(eq(trips.id, item.id)).limit(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.importBatchId).toBeNull();

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, item.id), eq(auditLogs.action, "trip.create")));
    expect(audits).toHaveLength(1);
  });

  it("updates the existing trip on a repeat (customer, externalTripId) — no duplicate", async () => {
    const externalTripId = code("EXT-DUP");
    const baseInput = {
      customerId,
      externalTripId,
      originLocationId: originId,
      destinationLocationId: destId,
    };

    const first = await createOrUpdateTripManually(
      { ...baseInput, plannedVolumeUnits: 10 },
      actorId,
    );
    createdTripIds.push(first.item.id);
    expect(first.updated).toBe(false);

    // Repeat with the SAME external id but a changed critical plan field (the pickup window).
    const newPickup = new Date("2026-07-01T09:00:00.000Z");
    const second = await createOrUpdateTripManually(
      { ...baseInput, plannedVolumeUnits: 10, plannedPickupWindowStart: newPickup },
      actorId,
    );

    expect(second.updated).toBe(true);
    expect(second.item.id).toBe(first.item.id);

    // Exactly ONE trip exists for that (customer, external id).
    const matches = await db
      .select({ id: trips.id })
      .from(trips)
      .where(
        and(eq(trips.customerId, customerId), eq(trips.externalTripId, externalTripId)),
      );
    expect(matches).toHaveLength(1);
  });
});
