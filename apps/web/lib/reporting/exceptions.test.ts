import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  customers,
  db,
  exceptions,
  lanes,
  locations,
  queryExceptionReport,
  reasonCodes,
  trips,
  users,
} from "@brazil-tms/db";

/**
 * Feature 009 US2 — `queryExceptionReport` integration (data-model §3). Seeds exceptions across
 * reason-code categories / severities / states for a customer-month, then asserts volume by category +
 * severity, open/resolved counts, and avg resolution minutes. Static imports + skipIf per MEMORY.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("queryExceptionReport (integration, US2)", () => {
  let actorId = "";
  let customerId = "";
  let originId = "";
  let destId = "";
  let laneId = "";
  let tripId = "";
  let rcDelayId = "";
  let rcAccidentId = "";
  const excIds: string[] = [];

  function code(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  const FROM = "2026-05-01";
  const TO = "2026-05-31";

  async function seedException(opts: {
    reasonCodeId: string;
    severity: "low" | "medium" | "high";
    status: "open" | "monitoring" | "resolved";
    openedAt: string;
    resolvedAt?: string;
  }): Promise<void> {
    const inserted = await db
      .insert(exceptions)
      .values({
        tripId,
        reasonCodeId: opts.reasonCodeId,
        severity: opts.severity,
        status: opts.status,
        responsibleParty: "carrier_caused",
        ownerUserId: actorId,
        createdByUserId: actorId,
        description: "teste",
        openedAt: new Date(opts.openedAt),
        resolvedAt: opts.resolvedAt ? new Date(opts.resolvedAt) : null,
      })
      .returning({ id: exceptions.id });
    excIds.push(inserted[0]!.id);
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
      .values({ name: "Cliente Exc Report", customerCode: code("CUST") })
      .returning({ id: customers.id });
    customerId = cust[0]!.id;
    const origin = await db
      .insert(locations)
      .values({ customerId, code: code("ORIG"), name: "Origem Exc" })
      .returning({ id: locations.id });
    originId = origin[0]!.id;
    const dest = await db
      .insert(locations)
      .values({ customerId, code: code("DEST"), name: "Destino Exc" })
      .returning({ id: locations.id });
    destId = dest[0]!.id;
    const lane = await db
      .insert(lanes)
      .values({ customerId, originLocationId: originId, destinationLocationId: destId })
      .returning({ id: lanes.id });
    laneId = lane[0]!.id;
    const trip = await db
      .insert(trips)
      .values({
        customerId,
        externalTripId: code("EXT"),
        originLocationId: originId,
        destinationLocationId: destId,
        laneId,
        currentStatus: "in_transit",
        originalPlan: { customerId, originLocationId: originId, destinationLocationId: destId },
        plannedPickupWindowStart: new Date("2026-05-10T08:00:00.000Z"),
      })
      .returning({ id: trips.id });
    tripId = trip[0]!.id;

    const rcDelay = await db
      .insert(reasonCodes)
      .values({
        code: code("RC-DELAY"),
        category: "delay",
        labelPt: "Atraso",
        defaultSeverity: "medium",
        defaultResponsibleParty: "carrier_caused",
      })
      .returning({ id: reasonCodes.id });
    rcDelayId = rcDelay[0]!.id;
    const rcAcc = await db
      .insert(reasonCodes)
      .values({
        code: code("RC-ACC"),
        category: "accident",
        labelPt: "Acidente",
        defaultSeverity: "high",
        defaultResponsibleParty: "carrier_caused",
      })
      .returning({ id: reasonCodes.id });
    rcAccidentId = rcAcc[0]!.id;

    // delay/high/resolved — 120 min resolution.
    await seedException({
      reasonCodeId: rcDelayId,
      severity: "high",
      status: "resolved",
      openedAt: "2026-05-10T10:00:00.000Z",
      resolvedAt: "2026-05-10T12:00:00.000Z",
    });
    // delay/medium/open.
    await seedException({
      reasonCodeId: rcDelayId,
      severity: "medium",
      status: "open",
      openedAt: "2026-05-11T10:00:00.000Z",
    });
    // accident/low/monitoring (counts as open).
    await seedException({
      reasonCodeId: rcAccidentId,
      severity: "low",
      status: "monitoring",
      openedAt: "2026-05-12T10:00:00.000Z",
    });
  });

  afterAll(async () => {
    if (excIds.length) await db.delete(exceptions).where(inArray(exceptions.id, excIds));
    if (tripId) await db.delete(trips).where(eq(trips.id, tripId));
    await db
      .delete(reasonCodes)
      .where(inArray(reasonCodes.id, [rcDelayId, rcAccidentId].filter(Boolean)));
    if (laneId) await db.delete(lanes).where(eq(lanes.id, laneId));
    await db.delete(locations).where(inArray(locations.id, [originId, destId]));
    if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
  });

  it("computes totals, open/resolved, and avg resolution minutes", async () => {
    const report = await queryExceptionReport({ customerId, from: FROM, to: TO, groupBy: "customer" });
    expect(report.totals.total).toBe(3);
    expect(report.totals.open).toBe(2); // open + monitoring
    expect(report.totals.resolved).toBe(1);
    expect(report.totals.avgResolutionMinutes).toBe(120);
  });

  it("breaks volume down by reason-code category and severity", async () => {
    const report = await queryExceptionReport({ customerId, from: FROM, to: TO, groupBy: "customer" });
    const byCat = Object.fromEntries(report.byCategory.map((r) => [r.category, r.count]));
    expect(byCat.delay).toBe(2);
    expect(byCat.accident).toBe(1);
    const bySev = Object.fromEntries(report.bySeverity.map((r) => [r.severity, r.count]));
    expect(bySev.high).toBe(1);
    expect(bySev.medium).toBe(1);
    expect(bySev.low).toBe(1);
  });

  it("groups by customer with total/open/resolved", async () => {
    const report = await queryExceptionReport({ customerId, from: FROM, to: TO, groupBy: "customer" });
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]!.groupKey).toBe(customerId);
    expect(report.groups[0]!.total).toBe(3);
    expect(report.groups[0]!.open).toBe(2);
    expect(report.groups[0]!.resolved).toBe(1);
  });
});
