import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLogs, customers, db, locations, tripEvents, trips, users } from "@brazil-tms/db";
import type { TripStatus } from "@brazil-tms/shared";
import { getTrip, listTrips } from "./trips-service";
import { transitionTripStatus } from "./trip-transitions";
import { Conflict } from "@/lib/api/respond";

/**
 * US5 (T030) — the billing-phase states are the tail of the ONE status machine, governed by the same
 * transition table; `billingStatus` is a derived projection that tracks `current_status`, never a
 * second machine (FR-013, FR-014, SC-005). Gating predicates are deferred to 008 and NOT enforced
 * here. Integration test against the live dev DB.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("billing-phase projection (integration, US5)", () => {
  let actorId = "";
  let customerId = "";
  let originId = "";
  let destId = "";
  const createdTripIds: string[] = [];

  function code(prefix = "BILLING-TEST"): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  /** Insert a trip directly at a chosen status (test setup bypasses the machine deliberately). */
  async function seedTripAt(status: TripStatus): Promise<string> {
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
      .values({ name: "Cliente Faturamento", customerCode: code("CUST") })
      .returning();
    customerId = cust[0]!.id;
    const origin = await db
      .insert(locations)
      .values({ customerId, code: code("ORIG"), name: "Origem Fat" })
      .returning();
    originId = origin[0]!.id;
    const dest = await db
      .insert(locations)
      .values({ customerId, code: code("DEST"), name: "Destino Fat" })
      .returning();
    destId = dest[0]!.id;
  });

  afterAll(async () => {
    for (const id of createdTripIds) {
      await db.delete(tripEvents).where(eq(tripEvents.tripId, id));
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(trips).where(eq(trips.id, id));
    }
    for (const id of [originId, destId]) {
      if (id) await db.delete(locations).where(eq(locations.id, id));
    }
    if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
  });

  it("completed → billing_pending → billing_ready → billed is accepted via the same machine, and billingStatus tracks", async () => {
    const id = await seedTripAt("completed");

    const completed = await getTrip(id);
    expect(completed!.currentStatus).toBe("completed");
    expect(completed!.billingStatus).toBeNull(); // completed is NOT a billing-phase status

    const r1 = await transitionTripStatus(
      id,
      { toStatus: "billing_pending", expectedFromStatus: "completed" },
      actorId,
    );
    expect(r1.currentStatus).toBe("billing_pending");
    expect(r1.billingStatus).toBe("billing_pending");

    const r2 = await transitionTripStatus(
      id,
      { toStatus: "billing_ready", expectedFromStatus: "billing_pending" },
      actorId,
    );
    expect(r2.billingStatus).toBe("billing_ready");

    const r3 = await transitionTripStatus(
      id,
      { toStatus: "billed", expectedFromStatus: "billing_ready" },
      actorId,
    );
    expect(r3.billingStatus).toBe("billed");
  });

  it("billing_pending → billed (skipping billing_ready) is ILLEGAL_TRANSITION", async () => {
    const id = await seedTripAt("billing_pending");
    await expect(
      transitionTripStatus(
        id,
        { toStatus: "billed", expectedFromStatus: "billing_pending" },
        actorId,
      ),
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    // status unchanged
    const after = await getTrip(id);
    expect(after!.currentStatus).toBe("billing_pending");
  });

  it("the list DTO surfaces billingStatus tracking current_status (null for non-billing)", async () => {
    const billingId = await seedTripAt("billing_ready");
    const nonBillingId = await seedTripAt("received");

    const list = await listTrips({ customerId });
    const billed = list.find((t) => t.id === billingId);
    const received = list.find((t) => t.id === nonBillingId);
    expect(billed?.billingStatus).toBe("billing_ready");
    expect(received?.billingStatus).toBeNull();
  });

  it("disputed projects to 'disputed' and resolves back to the status it was entered from", async () => {
    const id = await seedTripAt("billing_ready");

    const disputed = await transitionTripStatus(
      id,
      { toStatus: "disputed", expectedFromStatus: "billing_ready" },
      actorId,
    );
    expect(disputed.currentStatus).toBe("disputed");
    expect(disputed.billingStatus).toBe("disputed"); // disputed is a billing-phase projection value
    expect(disputed.disputedFromStatus).toBe("billing_ready");

    const resolved = await transitionTripStatus(
      id,
      { toStatus: "billing_ready", expectedFromStatus: "disputed" },
      actorId,
    );
    expect(resolved.currentStatus).toBe("billing_ready");
    expect(resolved.disputedFromStatus).toBeNull();
  });

  it("a Conflict is thrown (not a silent no-op) on an illegal billing transition", async () => {
    const id = await seedTripAt("billing_pending");
    await expect(
      transitionTripStatus(id, { toStatus: "completed", expectedFromStatus: "billing_pending" }, actorId),
    ).rejects.toBeInstanceOf(Conflict);
  });
});
