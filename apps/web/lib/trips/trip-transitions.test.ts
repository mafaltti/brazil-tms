import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditLogs,
  customers,
  db,
  locations,
  tripEvents,
  trips,
  users,
} from "@brazil-tms/db";
import type { TripStatus } from "@brazil-tms/shared";
import { Conflict } from "@/lib/api/respond";
import { transitionTripStatus } from "./trip-transitions";

/**
 * Integration test against the live dev DB (US2). Static imports per project convention; the Drizzle
 * `db` connects lazily, so importing is safe. The suite skips when DATABASE_URL is unset (e.g. CI
 * without a database) so the default `pnpm test` stays green. To run it:
 *   $env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'; pnpm exec vitest run --project web
 *
 * Focus: the atomic, status-guarded transition service (R7, FR-008..FR-012, SC-001, SC-003) —
 * legal-path acceptance, illegal-transition rejection with NO state change, optimistic-concurrency
 * staleness, one event + one audit per transition, and the disputed round-trip.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("trip-transitions (integration)", () => {
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

  /** Insert a trip directly at a known status (bypasses the service to set up preconditions). */
  async function createTripAt(status: TripStatus): Promise<string> {
    const inserted = await db
      .insert(trips)
      .values({
        customerId,
        originLocationId: originId,
        destinationLocationId: destId,
        originalPlan: {},
        currentStatus: status,
      })
      .returning();
    const id = inserted[0]!.id;
    createdTripIds.push(id);
    return id;
  }

  /** Read a trip's persisted current status (asserting against the DB, not just the return value). */
  async function statusOf(id: string): Promise<string> {
    const rows = await db
      .select({ currentStatus: trips.currentStatus })
      .from(trips)
      .where(eq(trips.id, id))
      .limit(1);
    return rows[0]!.currentStatus;
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
    // FK-safe order: trip_events + trip audit → trips → locations (+ their audit) → customers.
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

  it("accepts the full legal lifecycle path (skipping the optional loading sub-state)", async () => {
    const tripId = await createTripAt("received");
    // slice 015: `received → assigned` directly (the `validated` hop was collapsed away).
    // at_origin → in_transit legally SKIPS the optional `loading`/`loaded` sub-states.
    const path: [TripStatus, TripStatus][] = [
      ["received", "assigned"],
      ["assigned", "confirmed"],
      ["confirmed", "at_origin"],
      ["at_origin", "in_transit"],
      ["in_transit", "at_destination"],
      ["at_destination", "unloaded"],
      ["unloaded", "completed"],
    ];
    for (const [expectedFromStatus, toStatus] of path) {
      const detail = await transitionTripStatus(
        tripId,
        { toStatus, expectedFromStatus },
        actorId,
      );
      expect(detail.currentStatus).toBe(toStatus);
    }
    expect(await statusOf(tripId)).toBe("completed");
  });

  it("rejects an illegal transition (received → in_transit) and changes NO state (SC-001)", async () => {
    const tripId = await createTripAt("received");
    await expect(
      transitionTripStatus(
        tripId,
        { toStatus: "in_transit", expectedFromStatus: "received" },
        actorId,
      ),
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    // The denied transition must have left the row untouched.
    expect(await statusOf(tripId)).toBe("received");
    // ...and emitted no event for it.
    const events = await db.select().from(tripEvents).where(eq(tripEvents.tripId, tripId));
    expect(events).toHaveLength(0);
  });

  it("rejects a stale transition when expectedFromStatus does not match the row (STALE_TRANSITION)", async () => {
    const tripId = await createTripAt("received");
    // The caller believes the trip is at 'assigned' (a legal source for 'confirmed', so it passes the
    // legality gate), but the row is actually still at 'received'. The status-guarded UPDATE matches 0
    // rows → STALE_TRANSITION, distinct from an illegal transition (the trip never moved). (slice 015
    // re-pointed this off the removed `validated` source: `assigned` is now `received`'s only legal
    // source, so the stale probe uses the `assigned → confirmed` pair instead.)
    await expect(
      transitionTripStatus(
        tripId,
        { toStatus: "confirmed", expectedFromStatus: "assigned" },
        actorId,
      ),
    ).rejects.toBeInstanceOf(Conflict);
    await expect(
      transitionTripStatus(
        tripId,
        { toStatus: "confirmed", expectedFromStatus: "assigned" },
        actorId,
      ),
    ).rejects.toMatchObject({ code: "STALE_TRANSITION" });
    expect(await statusOf(tripId)).toBe("received");
  });

  it("writes exactly one trip_event and one audit row per successful transition (SC-003)", async () => {
    const tripId = await createTripAt("received");
    const detail = await transitionTripStatus(
      tripId,
      { toStatus: "assigned", expectedFromStatus: "received" },
      actorId,
    );
    expect(detail.currentStatus).toBe("assigned");

    const events = await db
      .select()
      .from(tripEvents)
      .where(and(eq(tripEvents.tripId, tripId), eq(tripEvents.eventType, "status_change")));
    expect(events).toHaveLength(1);
    expect(events[0]!.statusBefore).toBe("received");
    expect(events[0]!.statusAfter).toBe("assigned");

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, tripId), eq(auditLogs.action, "trip.status_change")));
    expect(audits).toHaveLength(1);
  });

  it("supports the disputed round-trip: completed → disputed → back to completed (FR-011)", async () => {
    // Drive a trip to completed via the legal path.
    const tripId = await createTripAt("received");
    const toCompleted: [TripStatus, TripStatus][] = [
      ["received", "assigned"],
      ["assigned", "confirmed"],
      ["confirmed", "at_origin"],
      ["at_origin", "in_transit"],
      ["in_transit", "at_destination"],
      ["at_destination", "unloaded"],
      ["unloaded", "completed"],
    ];
    for (const [expectedFromStatus, toStatus] of toCompleted) {
      await transitionTripStatus(tripId, { toStatus, expectedFromStatus }, actorId);
    }

    // completed → disputed records where the dispute was entered from.
    const disputed = await transitionTripStatus(
      tripId,
      { toStatus: "disputed", expectedFromStatus: "completed" },
      actorId,
    );
    expect(disputed.currentStatus).toBe("disputed");
    expect(disputed.disputedFromStatus).toBe("completed");

    // disputed → completed (the recorded entered-from) is the dynamic, per-trip allowed target.
    const resolved = await transitionTripStatus(
      tripId,
      { toStatus: "completed", expectedFromStatus: "disputed" },
      actorId,
    );
    expect(resolved.currentStatus).toBe("completed");
    expect(resolved.disputedFromStatus).toBeNull();
  });

  it("runs the optional txHook side-write atomically with a successful transition", async () => {
    const tripId = await createTripAt("billing_ready");
    let hookRan = false;
    const detail = await transitionTripStatus(
      tripId,
      { toStatus: "billed", expectedFromStatus: "billing_ready" },
      actorId,
      async (tx) => {
        // A real caller (008 billing-export) writes a side-row through `tx`; here we just confirm the hook
        // runs INSIDE the transition's transaction and receives a usable tx handle.
        hookRan = true;
        await tx.select({ id: trips.id }).from(trips).where(eq(trips.id, tripId)).limit(1);
      },
    );
    expect(hookRan).toBe(true);
    expect(detail.currentStatus).toBe("billed");
    expect(await statusOf(tripId)).toBe("billed");
  });

  it("rolls the WHOLE transition back when the txHook throws — the side-write is atomic (no half-transition, FR-021)", async () => {
    const tripId = await createTripAt("billing_ready");
    // Models 008's export linking billing_items in the SAME tx as billing_ready → billed. If that side-write
    // fails (or the worker dies in this window), the status change MUST NOT persist — so a trip can never be
    // left billed-but-unlinked. This is the atomicity the hook buys (refutes the "autocommit between the
    // UPDATE and the hook" reading: every statement here runs against the same `tx`, committed only on return).
    await expect(
      transitionTripStatus(
        tripId,
        { toStatus: "billed", expectedFromStatus: "billing_ready" },
        actorId,
        async () => {
          throw new Error("simulated link-write failure");
        },
      ),
    ).rejects.toThrow("simulated link-write failure");

    // Rolled back: still billing_ready, with no status_change event and no audit row written.
    expect(await statusOf(tripId)).toBe("billing_ready");
    const events = await db
      .select()
      .from(tripEvents)
      .where(and(eq(tripEvents.tripId, tripId), eq(tripEvents.eventType, "status_change")));
    expect(events).toHaveLength(0);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, tripId), eq(auditLogs.action, "trip.status_change")));
    expect(audits).toHaveLength(0);
  });
});
