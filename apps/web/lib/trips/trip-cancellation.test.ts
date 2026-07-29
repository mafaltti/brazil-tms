import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { ZodError } from "zod";
import {
  alerts,
  auditLogs,
  cancellationOptions,
  createException,
  customers,
  db,
  exceptions,
  locations,
  reasonCodes,
  tripEvents,
  trips,
  users,
} from "@brazil-tms/db";
import {
  DISPATCH_PHASE_TRIP_STATUSES,
  type CancelTripInput,
  type TripStatus,
} from "@brazil-tms/shared";
import { Conflict } from "@/lib/api/respond";
import { cancelTrip, queryCancellationOptions } from "./trip-cancellation";

/**
 * Integration test for `cancelTrip` (US4) against the live dev DB. Static imports per project
 * convention; Drizzle `db` connects lazily so importing is safe. Skips when DATABASE_URL is unset.
 *   $env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
 *   pnpm --filter @brazil-tms/web exec vitest run lib/trips/trip-cancellation.test.ts
 *
 * This suite seeds AND clears its OWN config rows so it never depends on, nor pollutes, the shared
 * table (since 017 the seed also ships default `reason` rows — the suite stays self-contained and
 * restores anything it deactivates). Each cancel uses a DISTINCT trip so cases don't interfere.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("trip-cancellation (integration)", () => {
  let actorId = "";
  let customerId = "";
  let originLocationId = "";
  let destinationLocationId = "";
  let reasonCode = "";
  let billingImpactCode = "";
  let highReasonId = "";
  const createdTripIds: string[] = [];
  const createdOptionIds: string[] = [];
  const createdLocationIds: string[] = [];
  const createdCustomerIds: string[] = [];

  function code(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  /** Insert a fresh trip at a chosen status; tracked for FK-safe cleanup. */
  async function insertTrip(currentStatus: TripStatus): Promise<string> {
    const inserted = await db
      .insert(trips)
      .values({
        customerId,
        originLocationId,
        destinationLocationId,
        originalPlan: {},
        currentStatus,
      })
      .returning();
    const id = inserted[0]!.id;
    createdTripIds.push(id);
    return id;
  }

  const validInput = (): CancelTripInput => ({
    reasonCode,
    responsibleParty: "carrier_caused",
    billingImpact: billingImpactCode,
  });

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
      .values({ name: "Cliente Cancelamento", customerCode: code("CUST-CXL") })
      .returning();
    customerId = cust[0]!.id;
    createdCustomerIds.push(customerId);

    const origin = await db
      .insert(locations)
      .values({ customerId, code: code("ORIG"), name: "Origem Cancel" })
      .returning();
    originLocationId = origin[0]!.id;
    createdLocationIds.push(originLocationId);

    const dest = await db
      .insert(locations)
      .values({ customerId, code: code("DEST"), name: "Destino Cancel" })
      .returning();
    destinationLocationId = dest[0]!.id;
    createdLocationIds.push(destinationLocationId);

    // Seed the suite's OWN config: one active reason + one active billing_impact (unique codes).
    reasonCode = code("test_reason");
    billingImpactCode = code("test_nocharge");
    const reasonRow = await db
      .insert(cancellationOptions)
      .values({ kind: "reason", code: reasonCode, labelPt: "Motivo de teste", active: true })
      .returning();
    createdOptionIds.push(reasonRow[0]!.id);
    const billingRow = await db
      .insert(cancellationOptions)
      .values({
        kind: "billing_impact",
        code: billingImpactCode,
        labelPt: "Sem cobrança (teste)",
        active: true,
      })
      .returning();
    createdOptionIds.push(billingRow[0]!.id);

    // A high-severity reason code so an exception drives an At-Risk SLA state + an active alert.
    const high = await db
      .insert(reasonCodes)
      .values({
        code: code("RC"),
        category: "breakdown",
        labelPt: "Pane",
        defaultSeverity: "high",
        defaultResponsibleParty: "carrier_caused",
      })
      .returning();
    highReasonId = high[0]!.id;
  });

  afterAll(async () => {
    // FK-safe order: trip children (events + audit) → trips → options → locations → customers.
    for (const id of createdTripIds) {
      await db.delete(alerts).where(eq(alerts.tripId, id));
      await db.delete(exceptions).where(eq(exceptions.tripId, id));
      await db.delete(tripEvents).where(eq(tripEvents.tripId, id));
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(trips).where(eq(trips.id, id));
    }
    if (highReasonId) await db.delete(reasonCodes).where(eq(reasonCodes.id, highReasonId));
    for (const id of createdOptionIds) {
      await db.delete(cancellationOptions).where(eq(cancellationOptions.id, id));
    }
    for (const id of createdLocationIds) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(locations).where(eq(locations.id, id));
    }
    for (const id of createdCustomerIds) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(customers).where(eq(customers.id, id));
    }
  });

  it("cancels an in_transit trip with all five inputs; sets fields + one audit + one event", async () => {
    const tripId = await insertTrip("in_transit");
    const detail = await cancelTrip(tripId, validInput(), actorId);

    expect(detail.currentStatus).toBe("cancelled");
    expect(detail.cancellationReasonCode).toBe(reasonCode);
    expect(detail.cancellationResponsibleParty).toBe("carrier_caused");
    expect(detail.cancellationBillingImpact).toBe(billingImpactCode);
    expect(detail.cancelledAt).not.toBeNull();

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, tripId), eq(auditLogs.action, "trip.cancel")));
    expect(audits).toHaveLength(1);

    const events = await db
      .select()
      .from(tripEvents)
      .where(and(eq(tripEvents.tripId, tripId), eq(tripEvents.eventType, "status_change")));
    expect(events).toHaveLength(1);
    expect(events[0]!.statusBefore).toBe("in_transit");
    expect(events[0]!.statusAfter).toBe("cancelled");

    // The effective cancellation time (defaulted to now()) is captured on the trip, the event, and
    // the audit — never null, and the audit records all five inputs incl. cancelledAt (data-model).
    expect(events[0]!.eventTimestamp).not.toBeNull();
    expect(events[0]!.eventTimestamp!.toISOString()).toBe(detail.cancelledAt);
    expect((audits[0]!.newValue as Record<string, unknown>).cancelledAt).toBe(detail.cancelledAt);
    expect((audits[0]!.newValue as Record<string, unknown>).cancellationReasonCode).toBe(reasonCode);
  });

  it("records a provided cancellationTimestamp on the trip, its event, and the audit", async () => {
    const tripId = await insertTrip("in_transit");
    const when = new Date("2026-03-01T12:00:00.000Z");
    const detail = await cancelTrip(
      tripId,
      { ...validInput(), cancellationTimestamp: when },
      actorId,
    );
    expect(detail.cancelledAt).toBe(when.toISOString());

    const events = await db
      .select()
      .from(tripEvents)
      .where(and(eq(tripEvents.tripId, tripId), eq(tripEvents.eventType, "status_change")));
    expect(events[0]!.eventTimestamp!.toISOString()).toBe(when.toISOString());

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, tripId), eq(auditLogs.action, "trip.cancel")));
    expect((audits[0]!.newValue as Record<string, unknown>).cancelledAt).toBe(when.toISOString());
  });

  it("rejects a missing responsibleParty with a ZodError (five-input rule)", async () => {
    const tripId = await insertTrip("in_transit");
    const bad = { reasonCode, billingImpact: billingImpactCode } as unknown as CancelTripInput;
    await expect(cancelTrip(tripId, bad, actorId)).rejects.toBeInstanceOf(ZodError);
  });

  it("cancels from at_destination (cancellation legal through at_destination)", async () => {
    const tripId = await insertTrip("at_destination");
    const detail = await cancelTrip(tripId, validInput(), actorId);
    expect(detail.currentStatus).toBe("cancelled");
  });

  it("cancelling clears the trip's SLA risk state and auto-resolves its active alerts", async () => {
    // An in_transit trip with an open high-severity exception → At Risk + an active alert.
    const tripId = await insertTrip("in_transit");
    await createException(tripId, { reasonCodeId: highReasonId }, actorId);
    const activeBefore = await db
      .select({ id: alerts.id })
      .from(alerts)
      .where(and(eq(alerts.tripId, tripId), eq(alerts.state, "active")));
    expect(activeBefore.length).toBeGreaterThanOrEqual(1);

    // Cancelling is a TERMINAL transition and the worker sweep skips non-active trips, so cancelTrip
    // itself must recompute to clear the stale risk + resolve the alerts. (Regression guard: without
    // the recomputeTripSla call in cancelTrip, slaStatus/slaReasons stay set and the alert stays active.)
    const detail = await cancelTrip(tripId, validInput(), actorId);
    expect(detail.currentStatus).toBe("cancelled");

    const [trip] = await db
      .select({ s: trips.slaStatus, r: trips.slaReasons })
      .from(trips)
      .where(eq(trips.id, tripId))
      .limit(1);
    expect(trip!.s).toBeNull();
    expect(trip!.r).toBeNull();
    const stillActive = await db
      .select({ id: alerts.id })
      .from(alerts)
      .where(and(eq(alerts.tripId, tripId), inArray(alerts.state, ["active", "acknowledged"])));
    expect(stillActive).toHaveLength(0);
  });

  it("rejects cancelling a completed trip with NOT_CANCELLABLE", async () => {
    const tripId = await insertTrip("completed");
    await expect(cancelTrip(tripId, validInput(), actorId)).rejects.toMatchObject({
      code: "NOT_CANCELLABLE",
    });
    await expect(cancelTrip(tripId, validInput(), actorId)).rejects.toBeInstanceOf(Conflict);
  });

  // Run LAST among config-dependent cases: it deactivates the reason rows, then restores them.
  it("fails with CANCELLATION_NOT_CONFIGURED when no active reason rows exist", async () => {
    // Deactivate ALL active reason rows (the table may hold rows beyond this suite's own — since
    // 017 the seed ships defaults), remembering exactly which ids were active to restore them.
    const deactivated = await db
      .update(cancellationOptions)
      .set({ active: false })
      .where(and(eq(cancellationOptions.kind, "reason"), eq(cancellationOptions.active, true)))
      .returning({ id: cancellationOptions.id });

    try {
      const tripId = await insertTrip("in_transit");
      await expect(cancelTrip(tripId, validInput(), actorId)).rejects.toMatchObject({
        code: "CANCELLATION_NOT_CONFIGURED",
      });
    } finally {
      // Restore EVERY row this test deactivated (seeded defaults included), not just the suite's own.
      if (deactivated.length > 0) {
        await db
          .update(cancellationOptions)
          .set({ active: true })
          .where(
            inArray(
              cancellationOptions.id,
              deactivated.map((r) => r.id),
            ),
          );
      }
    }
  });

  // --- 017 — allowedSourceStatuses (§18 Dispatcher "Limited") + the options read model -----------

  it("cancels a received and a confirmed trip when allowedSourceStatuses covers the dispatch phase", async () => {
    for (const status of ["received", "confirmed"] as const) {
      const tripId = await insertTrip(status);
      const detail = await cancelTrip(tripId, validInput(), actorId, {
        allowedSourceStatuses: DISPATCH_PHASE_TRIP_STATUSES,
      });
      expect(detail.currentStatus).toBe("cancelled");
    }
  });

  it("rejects an in_transit trip with NOT_CANCELLABLE_BY_ROLE under the dispatch-phase limit — but cancels it without the limit", async () => {
    const tripId = await insertTrip("in_transit");
    await expect(
      cancelTrip(tripId, validInput(), actorId, {
        allowedSourceStatuses: DISPATCH_PHASE_TRIP_STATUSES,
      }),
    ).rejects.toMatchObject({ code: "NOT_CANCELLABLE_BY_ROLE" });

    // The same trip remains untouched and cancellable by an unrestricted caller (admin/ops manager).
    const detail = await cancelTrip(tripId, validInput(), actorId);
    expect(detail.currentStatus).toBe("cancelled");
  });

  it("queryCancellationOptions returns ACTIVE rows of both kinds, ordered, and omits inactive rows", async () => {
    // An inactive row that must NOT be served.
    const inactive = await db
      .insert(cancellationOptions)
      .values({
        kind: "reason",
        code: code("inactive_reason"),
        labelPt: "Inativo (teste)",
        active: false,
      })
      .returning();
    createdOptionIds.push(inactive[0]!.id);

    const items = await queryCancellationOptions();
    const codes = items.map((i) => i.code);
    expect(codes).toContain(reasonCode);
    expect(codes).toContain(billingImpactCode);
    expect(codes).not.toContain(inactive[0]!.code);
    // Ordered kind, then sort_order (the dialog renders the lists as served).
    const kinds = items.map((i) => i.kind);
    expect([...kinds].sort()).toEqual(kinds);
    for (const kind of ["reason", "billing_impact"] as const) {
      const sorts = items.filter((i) => i.kind === kind).map((i) => i.sortOrder);
      expect([...sorts].sort((a, b) => a - b)).toEqual(sorts);
    }
  });
});
