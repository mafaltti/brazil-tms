import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditLogs,
  billingItems,
  customers,
  alerts,
  db,
  documentRequirements,
  documentTypes,
  exportBatches,
  locations,
  queryBillingList,
  queryExportBatches,
  trips,
  users,
} from "@brazil-tms/db";
import { createExportBatch } from "./exports";

/**
 * Feature 008 (US5, T100) — export-batch creation guard + billing-list/history reads against the live
 * dev DB. Static imports; skips when DATABASE_URL is unset. (The enqueue is route-level; not asserted here.)
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("billing export + lists (integration, US5)", () => {
  let actorId = "";
  let customerId = "";
  let originId = "";
  let destId = "";
  let typeId = "";
  const PERIOD = "2026-07";
  const tripIds: string[] = [];
  const batchIds: string[] = [];

  function code(p: string): string {
    return `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  async function seedTripWithItem(status: "billing_pending" | "billing_ready"): Promise<string> {
    const id = (
      await db
        .insert(trips)
        .values({
          customerId,
          originLocationId: originId,
          destinationLocationId: destId,
          originalPlan: {},
          currentStatus: status,
        })
        .returning({ id: trips.id })
    )[0]!.id;
    tripIds.push(id);
    await db.insert(billingItems).values({
      tripId: id,
      customerId,
      baseFreightCents: 150_000,
      billingPeriod: PERIOD,
    });
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
      await db.insert(customers).values({ name: "Cli Export", customerCode: code("C") }).returning()
    )[0]!.id;
    originId = (await db.insert(locations).values({ customerId, code: code("O"), name: "O" }).returning())[0]!.id;
    destId = (await db.insert(locations).values({ customerId, code: code("D"), name: "D" }).returning())[0]!.id;
    typeId = (await db.insert(documentTypes).values({ code: code("dt"), labelPt: "POD" }).returning())[0]!.id;
    // A required-for-billing doc with no upload ⇒ the trips show a missing-proof flag.
    await db.insert(documentRequirements).values({ customerId, documentTypeId: typeId, requiredForBilling: true });

    await seedTripWithItem("billing_pending");
    await seedTripWithItem("billing_ready");
  });

  afterAll(async () => {
    for (const id of batchIds) await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
    await db.delete(exportBatches).where(eq(exportBatches.customerId, customerId));
    for (const id of tripIds) {
      await db.delete(billingItems).where(eq(billingItems.tripId, id));
      await db.delete(alerts).where(eq(alerts.tripId, id));
      await db.delete(trips).where(eq(trips.id, id));
    }
    await db.delete(documentRequirements).where(eq(documentRequirements.customerId, customerId));
    if (typeId) await db.delete(documentTypes).where(eq(documentTypes.id, typeId));
    for (const id of [originId, destId]) if (id) await db.delete(locations).where(eq(locations.id, id));
    await db.delete(customers).where(eq(customers.id, customerId));
  });

  it("queryBillingList returns pending vs ready sets with the computed value + missing-proof flag", async () => {
    const pending = await queryBillingList({ scope: "pending", customerId, billingPeriod: PERIOD });
    const ready = await queryBillingList({ scope: "ready", customerId, billingPeriod: PERIOD });
    expect(pending.length).toBe(1);
    expect(ready.length).toBe(1);
    expect(pending[0]!.finalBillableCents).toBe(150_000);
    expect(ready[0]!.hasMissingProof).toBe(true); // required-for-billing doc missing
  });

  it("createExportBatch inserts a queued batch + a billing.export audit (NO_BILLABLE_TRIPS when empty)", async () => {
    const batch = await createExportBatch(
      { customerId, billingPeriod: PERIOD, format: "xlsx" },
      actorId,
    );
    batchIds.push(batch.id);
    expect(batch.status).toBe("queued");
    const audit = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, batch.id), eq(auditLogs.action, "billing.export")));
    expect(audit.length).toBe(1);

    await expect(
      createExportBatch({ customerId, billingPeriod: "1999-01", format: "xlsx" }, actorId),
    ).rejects.toMatchObject({ code: "NO_BILLABLE_TRIPS" });
  });

  it("queryExportBatches lists the batch history newest-first", async () => {
    const history = await queryExportBatches({ customerId });
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0]!.customerId).toBe(customerId);
  });
});
