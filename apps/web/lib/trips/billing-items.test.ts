import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditLogs,
  billingAdjustments,
  billingItems,
  customers,
  alerts,
  db,
  ensureBillingItem,
  locations,
  rates,
  trips,
  users,
} from "@brazil-tms/db";
import {
  addBillingAdjustment,
  loadBillingItemView,
  removeBillingAdjustment,
  updateBillingItem,
} from "./billing";

/**
 * Feature 008 (US4, T090) — billing-item helpers + mutations + computed values against the live dev
 * DB. Static imports; skips when DATABASE_URL is unset.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("billing items (integration, US4)", () => {
  let actorId = "";
  let customerId = "";
  let pricedCustomerId = "";
  let originId = "";
  let destId = "";
  let pOriginId = "";
  let pDestId = "";
  const tripIds: string[] = [];

  function code(p: string): string {
    return `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  async function seedTrip(cId: string, oId: string, dId: string): Promise<string> {
    const id = (
      await db
        .insert(trips)
        .values({
          customerId: cId,
          originLocationId: oId,
          destinationLocationId: dId,
          originalPlan: {},
          currentStatus: "billing_pending",
        })
        .returning({ id: trips.id })
    )[0]!.id;
    tripIds.push(id);
    return id;
  }

  beforeAll(async () => {
    actorId = (
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, "admin@braziltransports.com.br"))
        .limit(1)
    )[0]!.id;

    customerId = (
      await db.insert(customers).values({ name: "Cli Bill", customerCode: code("C") }).returning()
    )[0]!.id;
    pricedCustomerId = (
      await db.insert(customers).values({ name: "Cli Priced", customerCode: code("CP") }).returning()
    )[0]!.id;
    originId = (await db.insert(locations).values({ customerId, code: code("O"), name: "O" }).returning())[0]!.id;
    destId = (await db.insert(locations).values({ customerId, code: code("D"), name: "D" }).returning())[0]!.id;
    pOriginId = (
      await db.insert(locations).values({ customerId: pricedCustomerId, code: code("PO"), name: "PO" }).returning()
    )[0]!.id;
    pDestId = (
      await db.insert(locations).values({ customerId: pricedCustomerId, code: code("PD"), name: "PD" }).returning()
    )[0]!.id;
    // A rate only for the "priced" customer.
    await db.insert(rates).values({ customerId: pricedCustomerId, baseAmountCents: 150_000 });
  });

  afterAll(async () => {
    for (const id of tripIds) {
      const items = await db.select({ id: billingItems.id }).from(billingItems).where(eq(billingItems.tripId, id));
      for (const it of items) {
        await db.delete(billingAdjustments).where(eq(billingAdjustments.billingItemId, it.id));
        await db.delete(auditLogs).where(eq(auditLogs.entityId, it.id));
        await db.delete(billingItems).where(eq(billingItems.id, it.id));
      }
      await db.delete(alerts).where(eq(alerts.tripId, id));
      await db.delete(trips).where(eq(trips.id, id));
    }
    await db.delete(rates).where(eq(rates.customerId, pricedCustomerId));
    for (const id of [originId, destId, pOriginId, pDestId]) {
      if (id) await db.delete(locations).where(eq(locations.id, id));
    }
    await db.delete(customers).where(eq(customers.id, customerId));
    await db.delete(customers).where(eq(customers.id, pricedCustomerId));
  });

  it("ensureBillingItem auto-prices from a matching rate (else leaves base null)", async () => {
    const pricedTrip = await seedTrip(pricedCustomerId, pOriginId, pDestId);
    await db.transaction(async (tx) => ensureBillingItem(tx, pricedTrip));
    const pricedView = await loadBillingItemView(db, pricedTrip);
    expect(pricedView!.baseFreightCents).toBe(150_000);
    expect(pricedView!.hasRate).toBe(true);

    const unpricedTrip = await seedTrip(customerId, originId, destId);
    await db.transaction(async (tx) => ensureBillingItem(tx, unpricedTrip));
    const unpricedView = await loadBillingItemView(db, unpricedTrip);
    expect(unpricedView!.baseFreightCents).toBeNull();
    expect(unpricedView!.hasRate).toBe(false);
  });

  it("updateBillingItem sets a manual base + a billing_item.update audit", async () => {
    const tripId = tripIds.find((_, i) => i === 1)!; // the unpriced trip
    const view = await updateBillingItem(tripId, { baseFreightCents: 99_900 }, actorId);
    expect(view.baseFreightCents).toBe(99_900);
    const audit = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, view.id), eq(auditLogs.action, "billing_item.update")));
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it("addBillingAdjustment computes values (discounts subtracted); removeBillingAdjustment soft-removes", async () => {
    const tripId = tripIds[1]!; // base 99_900 from the previous test
    const actor = actorId;

    await addBillingAdjustment(tripId, { type: "toll", amountCents: 10_00 }, actor);
    const afterDiscount = await addBillingAdjustment(tripId, { type: "discount", amountCents: 5_00 }, actor);
    // executed 99_900 + toll 10_00 - discount 5_00 = 100_400
    expect(afterDiscount.adjustmentCents).toBe(10_00 - 5_00);
    expect(afterDiscount.finalBillableCents).toBe(99_900 + 10_00 - 5_00);
    expect(afterDiscount.adjustments.length).toBe(2);

    const toRemove = afterDiscount.adjustments[0]!;
    const afterRemove = await removeBillingAdjustment(toRemove.id, actor);
    // The removed one drops off the LIVE list.
    expect(afterRemove.adjustments.find((a) => a.id === toRemove.id)).toBeUndefined();
    // Soft-removed: the row still exists with removed_at set.
    const row = await db
      .select({ removedAt: billingAdjustments.removedAt })
      .from(billingAdjustments)
      .where(eq(billingAdjustments.id, toRemove.id))
      .limit(1);
    expect(row[0]!.removedAt).not.toBeNull();
  });
});
