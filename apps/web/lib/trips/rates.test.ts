import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditLogs,
  customers,
  db,
  lanes,
  locations,
  rates,
  resolveRate,
  users,
} from "@brazil-tms/db";
import { createRate, updateRate } from "./rates";

/**
 * Feature 008 (US4, T089) — rate precedence + CRUD against the live dev DB. Static imports; skips when
 * DATABASE_URL is unset.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("rates (integration, US4)", () => {
  let actorId = "";
  let customerId = "";
  let otherCustomerId = "";
  let originId = "";
  let destId = "";
  let laneId = "";
  const createdRateIds: string[] = [];

  function code(p: string): string {
    return `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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
      await db.insert(customers).values({ name: "Cli Rate", customerCode: code("C") }).returning()
    )[0]!.id;
    otherCustomerId = (
      await db.insert(customers).values({ name: "Cli Outro", customerCode: code("CO") }).returning()
    )[0]!.id;
    originId = (
      await db.insert(locations).values({ customerId, code: code("O"), name: "O" }).returning()
    )[0]!.id;
    destId = (
      await db.insert(locations).values({ customerId, code: code("D"), name: "D" }).returning()
    )[0]!.id;
    laneId = (
      await db
        .insert(lanes)
        .values({ customerId, originLocationId: originId, destinationLocationId: destId })
        .returning()
    )[0]!.id;

    // Three scopes for the same customer.
    await db.insert(rates).values({ customerId, baseAmountCents: 100_00 }); // customer-default
    await db.insert(rates).values({ customerId, laneId, baseAmountCents: 200_00 }); // lane-scoped
    await db.insert(rates).values({ customerId, laneId, vehicleType: "truck", baseAmountCents: 300_00 }); // lane+vt
    // An expired rate (effectiveEnd in the past) must not be selected.
    await db
      .insert(rates)
      .values({ customerId, baseAmountCents: 999_00, effectiveEnd: new Date("2020-01-01T00:00:00Z") });
  });

  afterAll(async () => {
    for (const id of createdRateIds) await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
    await db.delete(rates).where(eq(rates.customerId, customerId));
    await db.delete(lanes).where(eq(lanes.id, laneId));
    for (const id of [originId, destId]) if (id) await db.delete(locations).where(eq(locations.id, id));
    await db.delete(customers).where(eq(customers.id, customerId));
    await db.delete(customers).where(eq(customers.id, otherCustomerId));
  });

  it("resolveRate picks the most specific rate (lane+vehicle-type > lane > customer-default)", async () => {
    const at = new Date();
    const laneVt = await resolveRate({ customerId, laneId, plannedVehicleType: "truck", plannedPickupWindowStart: at });
    expect(laneVt!.baseAmountCents).toBe(300_00);

    const laneOnly = await resolveRate({ customerId, laneId, plannedVehicleType: "van", plannedPickupWindowStart: at });
    expect(laneOnly!.baseAmountCents).toBe(200_00);

    const customerDefault = await resolveRate({
      customerId,
      laneId: null,
      plannedVehicleType: "van",
      plannedPickupWindowStart: at,
    });
    expect(customerDefault!.baseAmountCents).toBe(100_00);
  });

  it("a rate outside its effective window is not selected; no match ⇒ null", async () => {
    const customerDefault = await resolveRate({
      customerId,
      laneId: null,
      plannedVehicleType: null,
      plannedPickupWindowStart: new Date(),
    });
    expect(customerDefault!.baseAmountCents).not.toBe(999_00); // the expired rate is excluded

    const none = await resolveRate({
      customerId: otherCustomerId,
      laneId: null,
      plannedVehicleType: null,
      plannedPickupWindowStart: new Date(),
    });
    expect(none).toBeNull();
  });

  it("createRate + updateRate write the row + rate.* audit", async () => {
    const created = await createRate(
      { customerId: otherCustomerId, baseAmountCents: 50_000, currency: "BRL", active: true },
      actorId,
    );
    createdRateIds.push(created.id);
    expect(created.baseAmountCents).toBe(50_000);
    const a1 = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, created.id), eq(auditLogs.action, "rate.create")));
    expect(a1.length).toBe(1);

    const updated = await updateRate(created.id, { baseAmountCents: 60_000 }, actorId);
    expect(updated.baseAmountCents).toBe(60_000);
    const a2 = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, created.id), eq(auditLogs.action, "rate.update")));
    expect(a2.length).toBe(1);

    await db.delete(rates).where(eq(rates.id, created.id));
  });

  it("updateRate on a non-existent id throws NotFound (404) — no spurious audit", async () => {
    const missingId = "99999999-9999-4999-8999-999999999999";
    await expect(updateRate(missingId, { baseAmountCents: 1 }, actorId)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    const audit = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.entityId, missingId));
    expect(audit.length).toBe(0);
  });
});
