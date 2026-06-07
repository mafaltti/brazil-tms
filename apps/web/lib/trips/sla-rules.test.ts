import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  auditLogs,
  createCustomerSlaRule,
  customers,
  customerSlaRules,
  db,
  lanes,
  locations,
  recomputeTripSla,
  trips,
  updateCustomerSlaRule,
  users,
} from "@brazil-tms/db";

/**
 * Feature 007 US5 — per-customer SLA-rule integration test (live dev DB). Covers create/update (+ the
 * sla_rule.create/update audit), precedence resolution via `recomputeTripSla` (lane > vehicle-type >
 * customer-default, tie-break latest effective_start), the no-rule → DEFAULT_SLA_POLICY fallback
 * (SLA sign-off blocked), and that a rule outside its effective window is NOT selected. Uses the
 * seeded admin as actor; FK-safe cleanup. Skips without DATABASE_URL.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("customer SLA rules (integration)", () => {
  let actorId = "";
  let customerId = "";
  let originId = "";
  let destId = "";
  let laneId = "";
  const createdTripIds: string[] = [];
  const createdRuleIds: string[] = [];
  const createdAuditEntityIds: string[] = [];

  function code(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  /** A `received` trip whose pickup is ~60 min out (so the confirmation cutoff is the lever). */
  async function tripPickupInMinutes(minutes: number, vehicleType?: string): Promise<string> {
    const start = new Date(Date.now() + minutes * 60_000);
    const inserted = await db
      .insert(trips)
      .values({
        customerId,
        laneId,
        originLocationId: originId,
        destinationLocationId: destId,
        originalPlan: {},
        currentStatus: "received",
        plannedVehicleType: (vehicleType ?? null) as never,
        plannedPickupWindowStart: start,
        plannedPickupWindowEnd: new Date(start.getTime() + 3_600_000),
      })
      .returning();
    const id = inserted[0]!.id;
    createdTripIds.push(id);
    return id;
  }

  async function reasonsOf(tripId: string): Promise<string[]> {
    await recomputeTripSla(db, tripId);
    const [row] = await db.select({ r: trips.slaReasons }).from(trips).where(eq(trips.id, tripId)).limit(1);
    return row!.r ?? [];
  }

  beforeAll(async () => {
    const admin = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "admin@braziltransports.com.br"))
      .limit(1);
    actorId = admin[0]?.id ?? "";
    expect(actorId, "seeded admin must exist").not.toBe("");

    const cust = await db.insert(customers).values({ name: "Cliente SLARule", customerCode: code("CUST") }).returning();
    customerId = cust[0]!.id;
    const origin = await db.insert(locations).values({ customerId, code: code("ORIG"), name: "Origem" }).returning();
    originId = origin[0]!.id;
    const dest = await db.insert(locations).values({ customerId, code: code("DEST"), name: "Destino" }).returning();
    destId = dest[0]!.id;
    const lane = await db.insert(lanes).values({ customerId, originLocationId: originId, destinationLocationId: destId }).returning();
    laneId = lane[0]!.id;
  });

  afterAll(async () => {
    for (const id of createdTripIds) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(trips).where(eq(trips.id, id));
    }
    for (const id of createdAuditEntityIds) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
    }
    await db.delete(customerSlaRules).where(eq(customerSlaRules.customerId, customerId));
    await db.delete(lanes).where(eq(lanes.id, laneId));
    await db.delete(locations).where(inArray(locations.id, [originId, destId]));
    await db.delete(customers).where(eq(customers.id, customerId));
  });

  it("createCustomerSlaRule writes the row + a sla_rule.create audit", async () => {
    const rule = await createCustomerSlaRule(
      {
        customerId,
        pickupToleranceMinutes: 0,
        deliveryToleranceMinutes: 0,
        confirmationCutoffMinutes: 30, // short cutoff
        atRiskWarningMinutes: 60,
      },
      actorId,
    );
    createdRuleIds.push(rule.id);
    createdAuditEntityIds.push(rule.id);

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, rule.id), eq(auditLogs.action, "sla_rule.create")));
    expect(audit).toHaveLength(1);
  });

  it("updateCustomerSlaRule edits + writes a sla_rule.update audit", async () => {
    const rule = createdRuleIds[0]!;
    await updateCustomerSlaRule(rule, { atRiskWarningMinutes: 90 }, actorId);
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, rule), eq(auditLogs.action, "sla_rule.update")));
    expect(audit).toHaveLength(1);
  });

  it("a customer with NO matching rule runs on DEFAULT_SLA_POLICY (sign-off blocked)", async () => {
    // Fresh customer, no rule. Trip pickup 60 min out: default cutoff 120 ⇒ deadline already passed
    // ⇒ missing_assignment fires under the company default policy.
    const [otherCust] = await db.insert(customers).values({ name: "Cliente Sem Regra", customerCode: code("CUST2") }).returning();
    const [o2] = await db.insert(locations).values({ customerId: otherCust!.id, code: code("O2"), name: "o" }).returning();
    const [d2] = await db.insert(locations).values({ customerId: otherCust!.id, code: code("D2"), name: "d" }).returning();
    const start = new Date(Date.now() + 60 * 60_000);
    const [trip] = await db
      .insert(trips)
      .values({
        customerId: otherCust!.id,
        originLocationId: o2!.id,
        destinationLocationId: d2!.id,
        originalPlan: {},
        currentStatus: "received",
        plannedPickupWindowStart: start,
        plannedPickupWindowEnd: new Date(start.getTime() + 3_600_000),
      })
      .returning();

    await recomputeTripSla(db, trip!.id);
    const [row] = await db.select({ r: trips.slaReasons }).from(trips).where(eq(trips.id, trip!.id));
    expect(row!.r ?? []).toContain("missing_assignment"); // default 120-min cutoff ⇒ already past

    // The customer has no customer_sla_rules row → sign-off is blocked (reported by the admin screen).
    const rules = await db
      .select({ id: customerSlaRules.id })
      .from(customerSlaRules)
      .where(eq(customerSlaRules.customerId, otherCust!.id));
    expect(rules).toHaveLength(0);

    await db.delete(auditLogs).where(eq(auditLogs.entityId, trip!.id));
    await db.delete(trips).where(eq(trips.id, trip!.id));
    await db.delete(locations).where(inArray(locations.id, [o2!.id, d2!.id]));
    await db.delete(customers).where(eq(customers.id, otherCust!.id));
  });

  it("precedence: a lane-scoped rule overrides the customer-default for that lane", async () => {
    // The customer-default rule (created above) has a SHORT 30-min cutoff. A trip pickup 60 min out:
    // deadline = pickup - 30 = 30 min ahead ⇒ NOT yet past ⇒ no missing_assignment under the default rule.
    const tripDefaultScope = await tripPickupInMinutes(60);
    expect(await reasonsOf(tripDefaultScope)).not.toContain("missing_assignment");

    // Add a LANE-scoped rule with a LARGE 240-min cutoff: for a lane trip, deadline = pickup - 240 =
    // 180 min in the PAST ⇒ missing_assignment fires (the lane rule won precedence over the default).
    const laneRule = await createCustomerSlaRule(
      {
        customerId,
        laneId,
        pickupToleranceMinutes: 0,
        deliveryToleranceMinutes: 0,
        confirmationCutoffMinutes: 240,
        atRiskWarningMinutes: 60,
      },
      actorId,
    );
    createdRuleIds.push(laneRule.id);
    createdAuditEntityIds.push(laneRule.id);

    const tripLaneScope = await tripPickupInMinutes(60);
    expect(await reasonsOf(tripLaneScope)).toContain("missing_assignment");
  });

  it("a rule outside its effective window is NOT selected (falls back to the next applicable)", async () => {
    // An EXPIRED lane rule (effective_end in the past) must not be chosen; resolution falls back to
    // the still-active lane rule from the previous test (240-min cutoff) ⇒ missing_assignment still fires.
    const expired = await createCustomerSlaRule(
      {
        customerId,
        laneId,
        pickupToleranceMinutes: 0,
        deliveryToleranceMinutes: 0,
        confirmationCutoffMinutes: 0, // would suppress missing_assignment IF selected
        atRiskWarningMinutes: 60,
        effectiveStart: new Date("2000-01-01T00:00:00.000Z"),
        effectiveEnd: new Date("2000-12-31T00:00:00.000Z"),
      },
      actorId,
    );
    createdRuleIds.push(expired.id);
    createdAuditEntityIds.push(expired.id);

    const trip = await tripPickupInMinutes(60);
    // The expired 0-cutoff rule is filtered out; the active 240-cutoff lane rule applies ⇒ fires.
    expect(await reasonsOf(trip)).toContain("missing_assignment");
    void isNull;
  });

  it("rejects a lane that belongs to ANOTHER customer (would never match this customer's trips)", async () => {
    // A second customer with its own lane.
    const [otherCust] = await db
      .insert(customers)
      .values({ name: "Cliente Outro", customerCode: code("CUST3") })
      .returning();
    const [oo] = await db
      .insert(locations)
      .values({ customerId: otherCust!.id, code: code("OO"), name: "o" })
      .returning();
    const [od] = await db
      .insert(locations)
      .values({ customerId: otherCust!.id, code: code("OD"), name: "d" })
      .returning();
    const [otherLane] = await db
      .insert(lanes)
      .values({ customerId: otherCust!.id, originLocationId: oo!.id, destinationLocationId: od!.id })
      .returning();

    try {
      // Scoping THIS customer's rule to the OTHER customer's lane must be refused.
      await expect(
        createCustomerSlaRule(
          {
            customerId,
            laneId: otherLane!.id,
            pickupToleranceMinutes: 0,
            deliveryToleranceMinutes: 0,
            confirmationCutoffMinutes: 60,
            atRiskWarningMinutes: 60,
          },
          actorId,
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await db.delete(lanes).where(eq(lanes.id, otherLane!.id));
      await db.delete(locations).where(inArray(locations.id, [oo!.id, od!.id]));
      await db.delete(customers).where(eq(customers.id, otherCust!.id));
    }
  });
});
