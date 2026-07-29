import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditLogs,
  billingItems,
  customers,
  alerts,
  db,
  documentRequirements,
  documents,
  documentTypes,
  locations,
  rates,
  tripEvents,
  trips,
  users,
} from "@brazil-tms/db";
import { markBillingReady, markCompleted } from "./billing";

/**
 * Feature 008 (US2, T069) — the gated completion + Billing-Ready transitions against the live dev DB.
 * Static imports; skips when DATABASE_URL is unset. Seeds a customer with a completion+billing-required
 * document type and a customer-default rate so auto-pricing + the gates are exercised end-to-end.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("completion + billing-ready gates (integration, US2)", () => {
  let actorId = "";
  let customerId = "";
  let originId = "";
  let destId = "";
  let typeId = "";
  const createdTripIds: string[] = [];

  function code(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  async function seedTripAt(status: "unloaded"): Promise<string> {
    const row = await db
      .insert(trips)
      .values({
        customerId,
        originLocationId: originId,
        destinationLocationId: destId,
        originalPlan: {},
        currentStatus: status,
      })
      .returning({ id: trips.id });
    createdTripIds.push(row[0]!.id);
    return row[0]!.id;
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
      .values({ name: "Cliente Conclusão", customerCode: code("CUST") })
      .returning();
    customerId = cust[0]!.id;
    originId = (
      await db.insert(locations).values({ customerId, code: code("O"), name: "Origem" }).returning()
    )[0]!.id;
    destId = (
      await db.insert(locations).values({ customerId, code: code("D"), name: "Destino" }).returning()
    )[0]!.id;

    typeId = (
      await db.insert(documentTypes).values({ code: code("dt"), labelPt: "POD" }).returning()
    )[0]!.id;
    // A document required for BOTH completion and billing.
    await db.insert(documentRequirements).values({
      customerId,
      documentTypeId: typeId,
      requiredForCompletion: true,
      requiredForBilling: true,
    });
    // A customer-default rate so completion auto-prices the billing item.
    await db.insert(rates).values({ customerId, baseAmountCents: 150_000 });
  });

  afterAll(async () => {
    for (const id of createdTripIds) {
      const items = await db.select({ id: billingItems.id }).from(billingItems).where(eq(billingItems.tripId, id));
      for (const it of items) {
        await db.delete(billingItems).where(eq(billingItems.id, it.id));
      }
      await db.delete(documents).where(eq(documents.tripId, id));
      await db.delete(tripEvents).where(eq(tripEvents.tripId, id));
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(alerts).where(eq(alerts.tripId, id));
      await db.delete(trips).where(eq(trips.id, id));
    }
    await db.delete(documentRequirements).where(eq(documentRequirements.customerId, customerId));
    await db.delete(rates).where(eq(rates.customerId, customerId));
    if (typeId) await db.delete(documentTypes).where(eq(documentTypes.id, typeId));
    for (const id of [originId, destId]) {
      if (id) await db.delete(locations).where(eq(locations.id, id));
    }
    if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
  });

  it("markCompleted is blocked when a completion-required document is missing", async () => {
    const tripId = await seedTripAt("unloaded");
    await expect(markCompleted(tripId, {}, actorId)).rejects.toMatchObject({
      code: "COMPLETION_BLOCKED",
    });
    const after = await db
      .select({ s: trips.currentStatus })
      .from(trips)
      .where(eq(trips.id, tripId))
      .limit(1);
    expect(after[0]!.s).toBe("unloaded"); // no state change
  });

  it("a waiver satisfies the gate; the trip completes, auto-advances to billing_pending, and is auto-priced", async () => {
    const tripId = await seedTripAt("unloaded");
    const detail = await markCompleted(
      tripId,
      { waivedRequirements: [{ documentTypeId: typeId, reason: "indisponível" }] },
      actorId,
    );
    expect(detail.currentStatus).toBe("billing_pending");
    expect(detail.billingStatus).toBe("billing_pending");

    // A waiver row (no file) was recorded + a document.waive audit.
    const waiver = detail.documents.find((d) => d.isWaiver);
    expect(waiver).toBeDefined();
    expect(waiver!.fileStorageKey).toBeNull();
    const waiveAudit = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, waiver!.id), eq(auditLogs.action, "document.waive")));
    expect(waiveAudit.length).toBe(1);

    // The billing item exists, auto-priced from the seeded rate, period set.
    expect(detail.billing).not.toBeNull();
    expect(detail.billing!.baseFreightCents).toBe(150_000);
    expect(detail.billing!.hasRate).toBe(true);
    expect(detail.billing!.billingPeriod).toMatch(/^\d{4}-\d{2}$/);

    // Both transitions were driven through transitionTripStatus (trip.status_change audits + events).
    const statusChanges = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, tripId), eq(auditLogs.action, "trip.status_change")));
    expect(statusChanges.length).toBeGreaterThanOrEqual(2);
    const events = await db
      .select({ id: tripEvents.id })
      .from(tripEvents)
      .where(and(eq(tripEvents.tripId, tripId), eq(tripEvents.eventType, "status_change")));
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it("markBillingReady is blocked by an open dispute, then succeeds once cleared", async () => {
    const tripId = await seedTripAt("unloaded");
    await markCompleted(
      tripId,
      { waivedRequirements: [{ documentTypeId: typeId, reason: "indisponível" }] },
      actorId,
    );

    // Open a billing dispute → §19.4 blocks.
    await db
      .update(billingItems)
      .set({ disputeStatus: "open" })
      .where(eq(billingItems.tripId, tripId));
    await expect(markBillingReady(tripId, {}, actorId)).rejects.toMatchObject({
      code: "BILLING_READY_BLOCKED",
    });

    // Clear it → the billing doc is waived, pricing present, no dispute → passes.
    await db
      .update(billingItems)
      .set({ disputeStatus: "none" })
      .where(eq(billingItems.tripId, tripId));
    const detail = await markBillingReady(tripId, {}, actorId);
    expect(detail.currentStatus).toBe("billing_ready");
    expect(detail.billingStatus).toBe("billing_ready");
  });
});
