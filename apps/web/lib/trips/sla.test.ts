import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  alerts,
  auditLogs,
  createCustomerSlaRule,
  createException,
  customers,
  customerSlaRules,
  db,
  exceptions,
  locations,
  recomputeTripSla,
  reasonCodes,
  trips,
  users,
} from "@brazil-tms/db";
import type { TripStatus } from "@brazil-tms/shared";

/**
 * Feature 007 US3 — `recomputeTripSla` integration test (live dev DB). Asserts the server-authoritative
 * SLA write for representative triggers (time-window late, missing assignment/confirmation, high-sev
 * exception), worst-state-wins, the terminal short-circuit (no write), and that a `customer_sla_rules`
 * row overrides `DEFAULT_SLA_POLICY`. Uses the seeded admin as actor; FK-safe cleanup. Skips without DB.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("recomputeTripSla (integration)", () => {
  let actorId = "";
  let customerId = "";
  let originId = "";
  let destId = "";
  let highReasonId = "";
  const createdTripIds: string[] = [];
  const createdRuleIds: string[] = [];

  function code(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  const PAST_PICKUP_START = new Date("2020-01-01T08:00:00.000Z");
  const PAST_PICKUP_END = new Date("2020-01-01T10:00:00.000Z");
  const FUTURE_PICKUP_START = new Date("2999-01-01T08:00:00.000Z");
  const FUTURE_PICKUP_END = new Date("2999-01-01T10:00:00.000Z");

  async function createTrip(
    currentStatus: TripStatus,
    windows: {
      pickupStart?: Date | null;
      pickupEnd?: Date | null;
      deliveryEnd?: Date | null;
      customerId?: string;
    } = {},
  ): Promise<string> {
    const inserted = await db
      .insert(trips)
      .values({
        customerId: windows.customerId ?? customerId,
        originLocationId: originId,
        destinationLocationId: destId,
        originalPlan: {},
        currentStatus,
        plannedPickupWindowStart: windows.pickupStart ?? null,
        plannedPickupWindowEnd: windows.pickupEnd ?? null,
        plannedDeliveryWindowEnd: windows.deliveryEnd ?? null,
      })
      .returning();
    const id = inserted[0]!.id;
    createdTripIds.push(id);
    return id;
  }

  async function slaOf(tripId: string): Promise<{ status: string | null; reasons: string[] | null }> {
    const [row] = await db
      .select({ status: trips.slaStatus, reasons: trips.slaReasons })
      .from(trips)
      .where(eq(trips.id, tripId))
      .limit(1);
    return { status: row!.status, reasons: row!.reasons };
  }

  beforeAll(async () => {
    const admin = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "admin@braziltransports.com.br"))
      .limit(1);
    actorId = admin[0]?.id ?? "";
    expect(actorId, "seeded admin must exist (run db:seed)").not.toBe("");

    const cust = await db.insert(customers).values({ name: "Cliente SLA", customerCode: code("CUST") }).returning();
    customerId = cust[0]!.id;
    const origin = await db.insert(locations).values({ customerId, code: code("ORIG"), name: "Origem" }).returning();
    originId = origin[0]!.id;
    const dest = await db.insert(locations).values({ customerId, code: code("DEST"), name: "Destino" }).returning();
    destId = dest[0]!.id;
    const high = await db
      .insert(reasonCodes)
      .values({ code: code("RC"), category: "breakdown", labelPt: "Pane", defaultSeverity: "high", defaultResponsibleParty: "carrier_caused" })
      .returning();
    highReasonId = high[0]!.id;
    createdRuleIds.push(); // placeholder; reason code cleaned below
  });

  afterAll(async () => {
    for (const id of createdTripIds) {
      await db.delete(alerts).where(eq(alerts.tripId, id));
      await db.delete(exceptions).where(eq(exceptions.tripId, id));
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(trips).where(eq(trips.id, id));
    }
    await db.delete(customerSlaRules).where(eq(customerSlaRules.customerId, customerId));
    await db.delete(reasonCodes).where(eq(reasonCodes.id, highReasonId));
    await db.delete(locations).where(inArray(locations.id, [originId, destId]));
    await db.delete(customers).where(eq(customers.id, customerId));
  });

  it("writes On Track for an active trip with future windows + no triggers", async () => {
    const tripId = await createTrip("confirmed", {
      pickupStart: FUTURE_PICKUP_START,
      pickupEnd: FUTURE_PICKUP_END,
    });
    await recomputeTripSla(db, tripId);
    const { status, reasons } = await slaOf(tripId);
    expect(status).toBe("on_track");
    expect(reasons).toEqual([]);
  });

  it("writes Late (window-miss) for a trip past its pickup window not yet at origin", async () => {
    const tripId = await createTrip("confirmed", {
      pickupStart: PAST_PICKUP_START,
      pickupEnd: PAST_PICKUP_END,
    });
    await recomputeTripSla(db, tripId);
    const { status, reasons } = await slaOf(tripId);
    expect(status).toBe("late");
    expect(reasons).toContain("delayed_origin_arrival");
  });

  it("worst-state-wins: a window-miss (Late) + an open high-sev exception (At Risk) ⇒ Late with both reasons", async () => {
    const tripId = await createTrip("confirmed", {
      pickupStart: PAST_PICKUP_START,
      pickupEnd: PAST_PICKUP_END,
    });
    // The high-severity exception's createException already recomputes; assert the combined result.
    await createException(tripId, { reasonCodeId: highReasonId }, actorId);
    const { status, reasons } = await slaOf(tripId);
    expect(status).toBe("late");
    expect(reasons).toContain("delayed_origin_arrival");
    expect(reasons).toContain("open_high_severity_exception");
    expect(status).not.toBe("breached"); // Breached is never produced in MVP
  });

  it("a trip that becomes terminal has its stale SLA risk CLEARED and active alerts auto-resolved", async () => {
    // Drive an active trip to Late + open a high-severity exception (→ an active alert + at-risk reason).
    const tripId = await createTrip("confirmed", {
      pickupStart: PAST_PICKUP_START,
      pickupEnd: PAST_PICKUP_END,
    });
    await createException(tripId, { reasonCodeId: highReasonId }, actorId);
    expect((await slaOf(tripId)).status).toBe("late");
    const activeBefore = await db
      .select({ id: alerts.id })
      .from(alerts)
      .where(and(eq(alerts.tripId, tripId), eq(alerts.state, "active")));
    expect(activeBefore.length).toBeGreaterThanOrEqual(1);

    // The trip closes (e.g. cancelled). Recompute must CLEAR the stale risk + resolve the alerts —
    // the worker sweep skips non-active trips, so without this they would linger forever.
    await db.update(trips).set({ currentStatus: "cancelled" }).where(eq(trips.id, tripId));
    await recomputeTripSla(db, tripId);

    const { status, reasons } = await slaOf(tripId);
    expect(status).toBeNull();
    expect(reasons).toBeNull();
    const stillActive = await db
      .select({ id: alerts.id })
      .from(alerts)
      .where(and(eq(alerts.tripId, tripId), inArray(alerts.state, ["active", "acknowledged"])));
    expect(stillActive).toHaveLength(0);
  });

  it("an already-terminal trip with no prior state stays null (no spurious write)", async () => {
    const tripId = await createTrip("completed", {
      pickupStart: PAST_PICKUP_START,
      pickupEnd: PAST_PICKUP_END,
    });
    await recomputeTripSla(db, tripId);
    const { status } = await slaOf(tripId);
    expect(status).toBeNull();
  });

  it("a customer_sla_rules row overrides DEFAULT_SLA_POLICY (a larger confirmation cutoff fires missing_assignment earlier)", async () => {
    // Pickup ~90 min out; default cutoff 120 ⇒ deadline already passed ⇒ missing_assignment under defaults.
    const soon = new Date(Date.now() + 90 * 60_000);
    const tripId = await createTrip("received", { pickupStart: soon, pickupEnd: new Date(soon.getTime() + 3_600_000) });

    // Under defaults (no rule): no assignment + past the 120-min lead point ⇒ missing_assignment.
    await recomputeTripSla(db, tripId);
    expect((await slaOf(tripId)).reasons).toContain("missing_assignment");

    // Add a rule with a SMALL confirmation cutoff (10 min): the lead deadline is now in the future ⇒
    // missing_assignment does NOT fire (the rule overrode the default policy).
    const rule = await createCustomerSlaRule(
      {
        customerId,
        pickupToleranceMinutes: 0,
        deliveryToleranceMinutes: 0,
        confirmationCutoffMinutes: 10,
        atRiskWarningMinutes: 60,
      },
      actorId,
    );
    createdRuleIds.push(rule.id);

    await recomputeTripSla(db, tripId);
    expect((await slaOf(tripId)).reasons ?? []).not.toContain("missing_assignment");
  });
});
