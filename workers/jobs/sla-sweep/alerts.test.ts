import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  alerts,
  auditLogs,
  createException,
  customers,
  db,
  exceptions,
  locations,
  reasonCodes,
  transitionException,
  trips,
  users,
} from "@brazil-tms/db";
import type { TripStatus } from "@brazil-tms/shared";
import { runSlaSweep } from "./index";

/**
 * Feature 007 US4 — alert generation through the worker sweep (T086), live dev DB. Covers: the
 * time-based cases generate one alert each; a re-run while the condition persists creates no
 * duplicate; the full clear→re-fire cycle through `runSlaSweep` for a time-based case; the
 * high_severity_exception worker BACKSTOP (re-creates a missing alert, auto-resolves when the last
 * high-sev exception closes); and the two deferred cases emit nothing. Skips without DATABASE_URL.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("sla-sweep alerts (integration)", () => {
  let actorId = "";
  let customerId = "";
  let originId = "";
  let destId = "";
  let highReasonId = "";
  const createdTripIds: string[] = [];

  function code(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  const PAST_END = new Date("2020-01-01T10:00:00.000Z");
  const FUTURE_END = new Date("2999-01-01T10:00:00.000Z");

  async function createTrip(currentStatus: TripStatus, pickupEnd: Date): Promise<string> {
    const inserted = await db
      .insert(trips)
      .values({
        customerId,
        originLocationId: originId,
        destinationLocationId: destId,
        originalPlan: {},
        currentStatus,
        plannedPickupWindowStart: new Date(pickupEnd.getTime() - 3_600_000),
        plannedPickupWindowEnd: pickupEnd,
      })
      .returning();
    const id = inserted[0]!.id;
    createdTripIds.push(id);
    return id;
  }

  async function alertsFor(tripId: string, alertCase: string): Promise<{ state: string }[]> {
    return db
      .select({ state: alerts.state })
      .from(alerts)
      .where(and(eq(alerts.tripId, tripId), eq(alerts.alertCase, alertCase as never)));
  }

  beforeAll(async () => {
    const admin = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "admin@braziltransports.com.br"))
      .limit(1);
    actorId = admin[0]?.id ?? "";
    expect(actorId, "seeded admin must exist").not.toBe("");

    const cust = await db.insert(customers).values({ name: "Cliente SweepAlerts", customerCode: code("CUST") }).returning();
    customerId = cust[0]!.id;
    const origin = await db.insert(locations).values({ customerId, code: code("ORIG"), name: "Origem" }).returning();
    originId = origin[0]!.id;
    const dest = await db.insert(locations).values({ customerId, code: code("DEST"), name: "Destino" }).returning();
    destId = dest[0]!.id;
    const rc = await db
      .insert(reasonCodes)
      .values({ code: code("RC"), category: "breakdown", labelPt: "Pane", defaultSeverity: "high", defaultResponsibleParty: "carrier_caused" })
      .returning();
    highReasonId = rc[0]!.id;
  });

  afterAll(async () => {
    for (const id of createdTripIds) {
      await db.delete(alerts).where(eq(alerts.tripId, id));
      await db.delete(exceptions).where(eq(exceptions.tripId, id));
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(trips).where(eq(trips.id, id));
    }
    await db.delete(reasonCodes).where(eq(reasonCodes.id, highReasonId));
    await db.delete(locations).where(inArray(locations.id, [originId, destId]));
    await db.delete(customers).where(eq(customers.id, customerId));
  });

  it("a time-based case (missed_origin_arrival) generates one alert; a re-run creates no duplicate", async () => {
    const tripId = await createTrip("confirmed", PAST_END);
    await runSlaSweep();
    let rows = await alertsFor(tripId, "missed_origin_arrival");
    expect(rows.filter((r) => r.state === "active")).toHaveLength(1);

    // Re-run while the condition persists ⇒ still exactly one active row (idempotent).
    await runSlaSweep();
    rows = await alertsFor(tripId, "missed_origin_arrival");
    expect(rows.filter((r) => r.state === "active")).toHaveLength(1);
  });

  it("the full clear→re-fire cycle through runSlaSweep (auto-resolve on clear, fresh row on recurrence)", async () => {
    const tripId = await createTrip("confirmed", PAST_END);
    await runSlaSweep(); // condition true ⇒ one active row
    expect((await alertsFor(tripId, "missed_origin_arrival")).filter((r) => r.state === "active")).toHaveLength(1);

    // Clear the condition: move the trip past origin (no longer "before origin" past window) and
    // push its windows to the future so no time-based reason fires.
    await db
      .update(trips)
      .set({ currentStatus: "at_origin", plannedPickupWindowEnd: FUTURE_END, plannedPickupWindowStart: new Date(FUTURE_END.getTime() - 3_600_000) })
      .where(eq(trips.id, tripId));
    await runSlaSweep(); // condition cleared ⇒ auto-resolve
    expect((await alertsFor(tripId, "missed_origin_arrival")).filter((r) => r.state === "active")).toHaveLength(0);
    expect((await alertsFor(tripId, "missed_origin_arrival")).filter((r) => r.state === "resolved")).toHaveLength(1);

    // Recurrence: back before origin + past window ⇒ a FRESH active row (prior stays resolved).
    await db
      .update(trips)
      .set({ currentStatus: "confirmed", plannedPickupWindowEnd: PAST_END, plannedPickupWindowStart: new Date(PAST_END.getTime() - 3_600_000) })
      .where(eq(trips.id, tripId));
    await runSlaSweep();
    const after = await alertsFor(tripId, "missed_origin_arrival");
    expect(after.filter((r) => r.state === "active")).toHaveLength(1);
    expect(after.filter((r) => r.state === "resolved")).toHaveLength(1);
  });

  it("the high_severity_exception backstop: sweep re-creates a deleted alert, auto-resolves on close", async () => {
    // A future-window trip so NO time-based reason fires — isolate the exception backstop.
    const tripId = await createTrip("confirmed", FUTURE_END);
    await createException(tripId, { reasonCodeId: highReasonId }, actorId); // synchronous alert raised

    // Simulate the synchronous path having missed it: delete the alert row.
    await db.delete(alerts).where(and(eq(alerts.tripId, tripId), eq(alerts.alertCase, "high_severity_exception")));
    expect((await alertsFor(tripId, "high_severity_exception")).length).toBe(0);

    // The sweep backstop re-creates it from the live open-high-sev count.
    await runSlaSweep();
    expect((await alertsFor(tripId, "high_severity_exception")).filter((r) => r.state === "active")).toHaveLength(1);

    // Close the (only) high-sev exception ⇒ the next sweep auto-resolves the backstop alert.
    const excRows = await db.select({ id: exceptions.id, status: exceptions.status }).from(exceptions).where(eq(exceptions.tripId, tripId));
    await transitionException(
      excRows[0]!.id,
      { expectedFromStatus: excRows[0]!.status as never, toStatus: "cancelled" },
      actorId,
    );
    await runSlaSweep();
    expect((await alertsFor(tripId, "high_severity_exception")).filter((r) => r.state === "active")).toHaveLength(0);
  });

  it("the two deferred cases (completed_missing_documents / billing_blocked_missing_proof) emit nothing", async () => {
    const tripId = await createTrip("confirmed", PAST_END);
    await runSlaSweep();
    expect((await alertsFor(tripId, "completed_missing_documents")).length).toBe(0);
    expect((await alertsFor(tripId, "billing_blocked_missing_proof")).length).toBe(0);
  });
});
