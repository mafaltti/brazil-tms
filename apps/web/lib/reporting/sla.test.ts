import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  customers,
  customerSlaRules,
  db,
  lanes,
  locations,
  querySlaReport,
  tripEvents,
  trips,
} from "@brazil-tms/db";

/**
 * Feature 009 US1 — `querySlaReport` integration (data-model §2). Seeds a customer/lane/month with
 * known SLA outcomes + actual arrival events, then asserts the on-time %s (via the shared `onTimeExpr`
 * — the SAME predicate the dashboard uses, so the two can never diverge) and the stored-`sla_status`
 * counts, grouped by customer then by lane, and the `provisional` flag toggling on a customer SLA rule.
 * Static imports + `skipIf(!DATABASE_URL)` per MEMORY (web vitest needs DATABASE_URL).
 */

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("querySlaReport (integration, US1)", () => {
  let customerId = "";
  let originId = "";
  let destId = "";
  let laneId = "";
  const tripIds: string[] = [];

  function code(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  // Seeded month: May 2026 (queried via explicit from/to so the test is independent of "now").
  const FROM = "2026-05-01";
  const TO = "2026-05-31";

  async function seedTrip(opts: {
    slaStatus: "on_track" | "at_risk" | "late" | "breached" | null;
    currentStatus?: "in_transit" | "completed" | "billed";
    pickupEnd: string; // planned pickup window end (UTC ISO)
    deliveryEnd: string; // planned delivery window end (UTC ISO)
    originArrivedAt?: string; // actual at_origin event ts
    destArrivedAt?: string; // actual at_destination event ts
  }): Promise<string> {
    const pickupStart = new Date("2026-05-12T08:00:00.000Z");
    const inserted = await db
      .insert(trips)
      .values({
        customerId,
        externalTripId: code("EXT"),
        originLocationId: originId,
        destinationLocationId: destId,
        laneId,
        currentStatus: opts.currentStatus ?? "in_transit",
        slaStatus: opts.slaStatus,
        originalPlan: { customerId, originLocationId: originId, destinationLocationId: destId },
        plannedPickupWindowStart: pickupStart,
        plannedPickupWindowEnd: new Date(opts.pickupEnd),
        plannedDeliveryWindowStart: new Date("2026-05-13T08:00:00.000Z"),
        plannedDeliveryWindowEnd: new Date(opts.deliveryEnd),
      })
      .returning({ id: trips.id });
    const id = inserted[0]!.id;
    tripIds.push(id);
    if (opts.originArrivedAt) {
      await db.insert(tripEvents).values({
        tripId: id,
        eventType: "status_change",
        statusAfter: "at_origin",
        source: "operator_manual",
        eventTimestamp: new Date(opts.originArrivedAt),
      });
    }
    if (opts.destArrivedAt) {
      await db.insert(tripEvents).values({
        tripId: id,
        eventType: "status_change",
        statusAfter: "at_destination",
        source: "operator_manual",
        eventTimestamp: new Date(opts.destArrivedAt),
      });
    }
    return id;
  }

  beforeAll(async () => {
    const cust = await db
      .insert(customers)
      .values({ name: "Cliente SLA Report", customerCode: code("CUST") })
      .returning({ id: customers.id });
    customerId = cust[0]!.id;
    const origin = await db
      .insert(locations)
      .values({ customerId, code: code("ORIG"), name: "Origem SLA" })
      .returning({ id: locations.id });
    originId = origin[0]!.id;
    const dest = await db
      .insert(locations)
      .values({ customerId, code: code("DEST"), name: "Destino SLA" })
      .returning({ id: locations.id });
    destId = dest[0]!.id;
    const lane = await db
      .insert(lanes)
      .values({ customerId, originLocationId: originId, destinationLocationId: destId })
      .returning({ id: lanes.id });
    laneId = lane[0]!.id;

    // Trip 1 — on_track; on-time pickup (arrived 11:00 ≤ 12:00 window) + LATE arrival (13:00 > 12:00).
    await seedTrip({
      slaStatus: "on_track",
      pickupEnd: "2026-05-12T12:00:00.000Z",
      deliveryEnd: "2026-05-13T12:00:00.000Z",
      originArrivedAt: "2026-05-12T11:00:00.000Z",
      destArrivedAt: "2026-05-13T13:00:00.000Z",
    });
    // Trip 2 — breached; LATE pickup (13:00 > 12:00), no destination arrival recorded.
    await seedTrip({
      slaStatus: "breached",
      pickupEnd: "2026-05-12T12:00:00.000Z",
      deliveryEnd: "2026-05-13T12:00:00.000Z",
      originArrivedAt: "2026-05-12T13:00:00.000Z",
    });
    // Trip 3 — at_risk; no actual arrivals recorded (excluded from both on-time denominators).
    await seedTrip({
      slaStatus: "at_risk",
      pickupEnd: "2026-05-12T12:00:00.000Z",
      deliveryEnd: "2026-05-13T12:00:00.000Z",
    });
    // Trip 4 — a CLOSED trip: 007 clears sla_status on terminal, so it carries NULL (the P1 case).
    // On-time pickup recorded (counts toward the pickup %), but no live SLA state → `settled`.
    await seedTrip({
      slaStatus: null,
      currentStatus: "billed",
      pickupEnd: "2026-05-12T12:00:00.000Z",
      deliveryEnd: "2026-05-13T12:00:00.000Z",
      originArrivedAt: "2026-05-12T10:30:00.000Z",
    });
  });

  afterAll(async () => {
    if (tripIds.length) {
      await db.delete(tripEvents).where(inArray(tripEvents.tripId, tripIds));
      await db.delete(trips).where(inArray(trips.id, tripIds));
    }
    await db.delete(customerSlaRules).where(eq(customerSlaRules.customerId, customerId));
    if (laneId) await db.delete(lanes).where(eq(lanes.id, laneId));
    await db.delete(locations).where(inArray(locations.id, [originId, destId]));
    if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
  });

  it("aggregates on-time %s and stored sla_status counts grouped by customer", async () => {
    const report = await querySlaReport({
      customerId,
      from: FROM,
      to: TO,
      groupBy: "customer",
    });

    expect(report.period.label).toBe("01/05/2026 – 31/05/2026");
    expect(report.groups).toHaveLength(1);
    const g = report.groups[0]!;
    expect(g.groupKey).toBe(customerId);
    expect(g.total).toBe(4);
    // SLA-state counts come from the STORED sla_status (never re-derived). The closed trip (trip4)
    // has NULL sla_status (007 cleared it) → `settled`, NOT a zeroed risk state.
    expect(g.onTrack).toBe(1);
    expect(g.atRisk).toBe(1);
    expect(g.late).toBe(0);
    expect(g.breached).toBe(1);
    expect(g.settled).toBe(1);
    // The five state buckets reconcile to total (no closed trip silently vanishes — the P1 fix).
    expect(g.onTrack + g.atRisk + g.late + g.breached + g.settled).toBe(g.total);
    // Pickup: 3 recorded (trip1 on-time, trip2 late, trip4 on-time) → 67%. Arrival: 1 recorded (trip1 late) → 0%.
    expect(g.onTimePickupPct).toBe(67);
    expect(g.onTimeArrivalPct).toBe(0);

    // Totals (ungrouped) mirror the single group here.
    expect(report.totals.total).toBe(4);
    expect(report.totals.onTimePickupPct).toBe(67);
    expect(report.totals.onTimeArrivalPct).toBe(0);
    expect(report.totals.breached).toBe(1);
    expect(report.totals.settled).toBe(1);
  });

  it("groups by lane with the derived lane label", async () => {
    const report = await querySlaReport({ customerId, from: FROM, to: TO, groupBy: "lane" });
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]!.groupKey).toBe(laneId);
    expect(report.groups[0]!.groupLabel).toContain("→");
    expect(report.groups[0]!.total).toBe(4);
  });

  it("is provisional when the customer has no active SLA rules, and clears once a rule exists", async () => {
    const before = await querySlaReport({ customerId, from: FROM, to: TO, groupBy: "customer" });
    expect(before.provisional).toBe(true);
    expect(before.provisionalReason).toBeTruthy();

    await db.insert(customerSlaRules).values({
      customerId,
      pickupToleranceMinutes: 0,
      deliveryToleranceMinutes: 0,
      confirmationCutoffMinutes: 120,
      atRiskWarningMinutes: 60,
      active: true,
    });

    const after = await querySlaReport({ customerId, from: FROM, to: TO, groupBy: "customer" });
    expect(after.provisional).toBe(false);
    expect(after.provisionalReason).toBeUndefined();
  });
});
