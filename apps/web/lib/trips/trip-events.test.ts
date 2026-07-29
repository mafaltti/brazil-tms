import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  addTripNote,
  auditLogs,
  customers,
  db,
  loadTripDetail,
  locations,
  transitionTripStatus,
  tripEvents,
  trips,
  users,
} from "@brazil-tms/db";
import type { TripStatus } from "@brazil-tms/shared";

/**
 * Feature 007 US1 — execution events integration test against the live dev DB. Static imports per the
 * project convention (the Drizzle `db` connects lazily). Skips when DATABASE_URL is unset so the
 * default `pnpm test` stays green. To run it:
 *   $env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
 *   pnpm exec vitest run --project web apps/web/lib/trips/trip-events.test.ts
 *
 * Uses the SEEDED admin as the actor (a `users` row FKs to GoTrue `auth.users`, so we never insert
 * one). Seeds its own customer/locations + a fresh trip per case; FK-safe cleanup.
 *
 * Covers: `addTripNote` → one `note` event, NO status change, `trip.note` audit, SLA recomputed; and a
 * milestone via `transitionTripStatus` → a `status_change` event AND SLA recomputed.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("trip-events (integration)", () => {
  let actorId = "";
  let customerId = "";
  let originId = "";
  let destId = "";
  const createdTripIds: string[] = [];
  const createdLocationIds: string[] = [];
  const createdCustomerIds: string[] = [];

  function code(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  async function createTripAt(currentStatus: TripStatus): Promise<string> {
    const inserted = await db
      .insert(trips)
      .values({ customerId, originLocationId: originId, destinationLocationId: destId, originalPlan: {}, currentStatus })
      .returning();
    const id = inserted[0]!.id;
    createdTripIds.push(id);
    return id;
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
      .values({ name: "Cliente Eventos", customerCode: code("CUST") })
      .returning();
    customerId = cust[0]!.id;
    createdCustomerIds.push(customerId);

    const origin = await db.insert(locations).values({ customerId, code: code("ORIG"), name: "Origem" }).returning();
    originId = origin[0]!.id;
    createdLocationIds.push(originId);

    const dest = await db.insert(locations).values({ customerId, code: code("DEST"), name: "Destino" }).returning();
    destId = dest[0]!.id;
    createdLocationIds.push(destId);
  });

  afterAll(async () => {
    for (const id of createdTripIds) {
      await db.delete(tripEvents).where(eq(tripEvents.tripId, id));
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(trips).where(eq(trips.id, id));
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

  it("addTripNote inserts one `note` event (no status change), a trip.note audit, and recomputes SLA", async () => {
    const tripId = await createTripAt("received");
    const before = await db.select({ s: trips.slaStatus }).from(trips).where(eq(trips.id, tripId));
    expect(before[0]!.s).toBeNull();

    const detail = await addTripNote(tripId, { notes: "Cliente avisou atraso." }, actorId);

    const noteEvents = await db
      .select()
      .from(tripEvents)
      .where(and(eq(tripEvents.tripId, tripId), eq(tripEvents.eventType, "note")));
    expect(noteEvents).toHaveLength(1);
    expect(noteEvents[0]!.notes).toBe("Cliente avisou atraso.");
    expect(noteEvents[0]!.statusBefore).toBeNull();
    expect(noteEvents[0]!.statusAfter).toBeNull();
    expect(noteEvents[0]!.source).toBe("operator_manual");

    const [row] = await db.select({ status: trips.currentStatus }).from(trips).where(eq(trips.id, tripId));
    expect(row!.status).toBe("received"); // no status change

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, tripId), eq(auditLogs.action, "trip.note")));
    expect(audit).toHaveLength(1);

    // SLA recomputed in-tx (null → a concrete state); the returned detail carries it + the note.
    const [after] = await db.select({ s: trips.slaStatus }).from(trips).where(eq(trips.id, tripId));
    expect(after!.s).not.toBeNull();
    expect(detail.slaStatus).toBe(after!.s);
    expect(detail.events.some((e) => e.eventType === "note")).toBe(true);
  });

  it("a milestone via transitionTripStatus records a status_change event AND recomputes SLA", async () => {
    const tripId = await createTripAt("confirmed");

    const detail = await transitionTripStatus(
      tripId,
      { expectedFromStatus: "confirmed", toStatus: "at_origin", source: "operator_manual" },
      actorId,
    );
    expect(detail.currentStatus).toBe("at_origin");

    const changes = await db
      .select()
      .from(tripEvents)
      .where(and(eq(tripEvents.tripId, tripId), eq(tripEvents.eventType, "status_change")));
    expect(changes.some((e) => e.statusAfter === "at_origin")).toBe(true);

    const reloaded = await loadTripDetail(db, tripId);
    expect(reloaded!.slaStatus).not.toBeNull();
  });
});
