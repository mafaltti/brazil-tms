import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  billingItems,
  customers,
  db,
  documentRequirements,
  documentTypes,
  locations,
  queryBillingReadinessReport,
  tripEvents,
  trips,
} from "@brazil-tms/db";

/**
 * Feature 009 US3 — `queryBillingReadinessReport` integration (data-model §4). Seeds billing-phase
 * trips + billing items for a customer-month with completion→billing_ready events, then asserts phase
 * counts (via the `billingStatus` projection), the completed-missing-documents count, `pctReadyWithin24h`
 * (completion→billing_ready gap ≤ 24h), and the `provisional` flag toggling on a document checklist.
 * Static imports + skipIf per MEMORY.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("queryBillingReadinessReport (integration, US3)", () => {
  let customerId = "";
  let originId = "";
  let destId = "";
  let docTypeId = "";
  let reqId = "";
  const tripIds: string[] = [];

  function code(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  const FROM = "2026-05-01";
  const TO = "2026-05-31";
  const PERIOD = "2026-05";

  async function seedBillingTrip(opts: {
    currentStatus: "billing_pending" | "billing_ready" | "billed" | "disputed";
    completedAt?: string;
    billingReadyAt?: string;
  }): Promise<string> {
    const trip = await db
      .insert(trips)
      .values({
        customerId,
        externalTripId: code("EXT"),
        originLocationId: originId,
        destinationLocationId: destId,
        currentStatus: opts.currentStatus,
        originalPlan: { customerId, originLocationId: originId, destinationLocationId: destId },
        plannedPickupWindowStart: new Date("2026-05-20T08:00:00.000Z"),
      })
      .returning({ id: trips.id });
    const tripId = trip[0]!.id;
    tripIds.push(tripId);
    await db
      .insert(billingItems)
      .values({ tripId, customerId, billingPeriod: PERIOD, baseFreightCents: 100000 });
    if (opts.completedAt) {
      await db.insert(tripEvents).values({
        tripId,
        eventType: "status_change",
        statusAfter: "completed",
        source: "operator_manual",
        eventTimestamp: new Date(opts.completedAt),
      });
    }
    if (opts.billingReadyAt) {
      await db.insert(tripEvents).values({
        tripId,
        eventType: "status_change",
        statusAfter: "billing_ready",
        source: "operator_manual",
        eventTimestamp: new Date(opts.billingReadyAt),
      });
    }
    return tripId;
  }

  beforeAll(async () => {
    const cust = await db
      .insert(customers)
      .values({ name: "Cliente Cobrança Report", customerCode: code("CUST") })
      .returning({ id: customers.id });
    customerId = cust[0]!.id;
    const origin = await db
      .insert(locations)
      .values({ customerId, code: code("ORIG"), name: "Origem Cob" })
      .returning({ id: locations.id });
    originId = origin[0]!.id;
    const dest = await db
      .insert(locations)
      .values({ customerId, code: code("DEST"), name: "Destino Cob" })
      .returning({ id: locations.id });
    destId = dest[0]!.id;
    const dt = await db
      .insert(documentTypes)
      .values({ code: code("DT"), labelPt: "Comprovante", sortOrder: 1 })
      .returning({ id: documentTypes.id });
    docTypeId = dt[0]!.id;

    // T1 billing_ready — completed 10:00, billing_ready 20:00 (10h ≤ 24h → ready within 24h).
    await seedBillingTrip({
      currentStatus: "billing_ready",
      completedAt: "2026-05-20T10:00:00.000Z",
      billingReadyAt: "2026-05-20T20:00:00.000Z",
    });
    // T2 billing_pending — completed but not yet billing_ready (counts in the 24h denom, not the num).
    await seedBillingTrip({
      currentStatus: "billing_pending",
      completedAt: "2026-05-21T10:00:00.000Z",
    });
  });

  afterAll(async () => {
    if (tripIds.length) {
      await db.delete(billingItems).where(inArray(billingItems.tripId, tripIds));
      await db.delete(tripEvents).where(inArray(tripEvents.tripId, tripIds));
      await db.delete(trips).where(inArray(trips.id, tripIds));
    }
    if (reqId) await db.delete(documentRequirements).where(eq(documentRequirements.id, reqId));
    if (docTypeId) await db.delete(documentTypes).where(eq(documentTypes.id, docTypeId));
    await db.delete(locations).where(inArray(locations.id, [originId, destId]));
    if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
  });

  it("computes phase counts, completed-missing-documents, and % ready within 24h", async () => {
    const report = await queryBillingReadinessReport({ customerId, from: FROM, to: TO, groupBy: "customer" });
    expect(report.phaseCounts.billing_ready).toBe(1);
    expect(report.phaseCounts.billing_pending).toBe(1);
    expect(report.phaseCounts.billed).toBe(0);
    expect(report.phaseCounts.disputed).toBe(0);
    // No documents uploaded + no checklist → both trips are completed-but-missing-documents.
    expect(report.completedMissingDocuments).toBe(2);
    // 2 completed (denom); 1 within 24h (T1) → 50%.
    expect(report.pctReadyWithin24h).toBe(50);
  });

  it("groups by customer with phase counts", async () => {
    const report = await queryBillingReadinessReport({ customerId, from: FROM, to: TO, groupBy: "customer" });
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]!.groupKey).toBe(customerId);
    expect(report.groups[0]!.billing_ready).toBe(1);
    expect(report.groups[0]!.billing_pending).toBe(1);
  });

  it("is provisional without a document checklist, and clears once one exists", async () => {
    const before = await queryBillingReadinessReport({ customerId, from: FROM, to: TO, groupBy: "customer" });
    expect(before.provisional).toBe(true);
    expect(before.provisionalReason).toBeTruthy();

    const req = await db
      .insert(documentRequirements)
      .values({
        customerId,
        documentTypeId: docTypeId,
        requiredForCompletion: false,
        requiredForBilling: true,
        active: true,
      })
      .returning({ id: documentRequirements.id });
    reqId = req[0]!.id;

    const after = await queryBillingReadinessReport({ customerId, from: FROM, to: TO, groupBy: "customer" });
    expect(after.provisional).toBe(false);
    expect(after.provisionalReason).toBeUndefined();
  });
});
