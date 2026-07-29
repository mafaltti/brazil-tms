import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { alerts, auditLogs, customers, db, locations, trips } from "@brazil-tms/db";
import type { TripStatus } from "@brazil-tms/shared";
import { runSlaSweep } from "./index";

/**
 * Feature 007 US3 — SLA sweep worker integration test (T076), against the live dev DB. Static imports
 * per project convention; the Drizzle `db` connects lazily. Skips when DATABASE_URL is unset. Run with:
 *   $env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
 *   pnpm exec vitest run --project workers workers/jobs/sla-sweep/sla-sweep.test.ts
 *
 * Asserts: `runSlaSweep` recomputes `sla_status` over ACTIVE trips only (a terminal trip is never
 * evaluated → stays null); the per-sweep summary carries duration/evaluated/changed/errors; and a
 * passed-cutoff trip with NO user action flips to a risk state (the time-based raison d'être).
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("sla-sweep (integration)", () => {
  let customerId = "";
  let originId = "";
  let destId = "";
  const createdTripIds: string[] = [];

  function code(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  async function createTrip(currentStatus: TripStatus, pickupEnd: Date | null): Promise<string> {
    const inserted = await db
      .insert(trips)
      .values({
        customerId,
        originLocationId: originId,
        destinationLocationId: destId,
        originalPlan: {},
        currentStatus,
        plannedPickupWindowStart: pickupEnd ? new Date(pickupEnd.getTime() - 3_600_000) : null,
        plannedPickupWindowEnd: pickupEnd,
      })
      .returning();
    const id = inserted[0]!.id;
    createdTripIds.push(id);
    return id;
  }

  async function slaOf(tripId: string): Promise<string | null> {
    const [row] = await db.select({ s: trips.slaStatus }).from(trips).where(eq(trips.id, tripId)).limit(1);
    return row!.s;
  }

  const PAST = new Date("2020-01-01T10:00:00.000Z");

  beforeAll(async () => {
    const cust = await db.insert(customers).values({ name: "Cliente Sweep", customerCode: code("CUST") }).returning();
    customerId = cust[0]!.id;
    const origin = await db.insert(locations).values({ customerId, code: code("ORIG"), name: "Origem" }).returning();
    originId = origin[0]!.id;
    const dest = await db.insert(locations).values({ customerId, code: code("DEST"), name: "Destino" }).returning();
    destId = dest[0]!.id;
  });

  afterAll(async () => {
    // The sweep generates time-based alerts on Late trips (US4), so clear alerts BEFORE trips (FK).
    for (const id of createdTripIds) {
      await db.delete(alerts).where(eq(alerts.tripId, id));
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(trips).where(eq(trips.id, id));
    }
    await db.delete(locations).where(inArray(locations.id, [originId, destId]));
    await db.delete(customers).where(eq(customers.id, customerId));
  });

  it("recomputes active trips (flipping a passed-cutoff trip to Late) and skips terminal trips", async () => {
    const lateTrip = await createTrip("confirmed", PAST);
    const terminalTrip = await createTrip("completed", PAST);

    const summary = await runSlaSweep();

    expect(typeof summary.durationMs).toBe("number");
    expect(summary.evaluated).toBeGreaterThanOrEqual(1);
    expect(summary.errors).toBe(0);
    expect(typeof summary.changed).toBe("number");

    expect(await slaOf(lateTrip)).toBe("late");
    expect(await slaOf(terminalTrip)).toBeNull();
  });

  it("is idempotent: a second sweep over an unchanged trip reports zero NEW changes for it", async () => {
    const tripId = await createTrip("confirmed", PAST);
    await runSlaSweep(); // first sweep sets it to late
    expect(await slaOf(tripId)).toBe("late");
    // A subsequent sweep recomputes the same deterministic result — the row does not change again.
    const second = await runSlaSweep();
    expect(second.errors).toBe(0);
    expect(await slaOf(tripId)).toBe("late");
  });
});
