import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  acknowledgeAlert,
  alerts,
  autoResolveAlert,
  customers,
  db,
  generateAlert,
  listAlerts,
  locations,
  trips,
  users,
} from "@brazil-tms/db";

/**
 * Feature 007 US4 — alert helpers integration test (live dev DB). Covers generateAlert idempotency
 * (the partial-unique ON CONFLICT), autoResolveAlert on clear, acknowledgeAlert (→ acknowledged then
 * STALE_ALERT on a resolved row), an acknowledged-but-still-true alert NOT regenerated, and a
 * recurrence after resolve inserting a fresh row. Uses the seeded admin as the acknowledger; FK-safe
 * cleanup. Skips without DATABASE_URL.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("alerts (integration)", () => {
  let actorId = "";
  let customerId = "";
  let originId = "";
  let destId = "";
  let tripId = "";

  function code(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  beforeAll(async () => {
    const admin = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "admin@braziltransports.com.br"))
      .limit(1);
    actorId = admin[0]?.id ?? "";
    expect(actorId, "seeded admin must exist").not.toBe("");

    const cust = await db.insert(customers).values({ name: "Cliente Alerts", customerCode: code("CUST") }).returning();
    customerId = cust[0]!.id;
    const origin = await db.insert(locations).values({ customerId, code: code("ORIG"), name: "Origem" }).returning();
    originId = origin[0]!.id;
    const dest = await db.insert(locations).values({ customerId, code: code("DEST"), name: "Destino" }).returning();
    destId = dest[0]!.id;
    const trip = await db
      .insert(trips)
      .values({ customerId, originLocationId: originId, destinationLocationId: destId, originalPlan: {}, currentStatus: "confirmed" })
      .returning();
    tripId = trip[0]!.id;
  });

  afterAll(async () => {
    await db.delete(alerts).where(eq(alerts.tripId, tripId));
    await db.delete(trips).where(eq(trips.id, tripId));
    await db.delete(locations).where(inArray(locations.id, [originId, destId]));
    await db.delete(customers).where(eq(customers.id, customerId));
  });

  async function activeCount(): Promise<number> {
    const rows = await db
      .select({ id: alerts.id })
      .from(alerts)
      .where(eq(alerts.tripId, tripId));
    return rows.length;
  }

  it("generateAlert is idempotent (a second call while active creates no duplicate)", async () => {
    const first = await generateAlert(db, tripId, "missed_origin_arrival", "high");
    expect(first).toBe(true); // inserted
    const second = await generateAlert(db, tripId, "missed_origin_arrival", "high");
    expect(second).toBe(false); // ON CONFLICT DO NOTHING — no duplicate
    const open = await db
      .select({ id: alerts.id })
      .from(alerts)
      .where(eq(alerts.tripId, tripId));
    expect(open.length).toBe(1);
  });

  it("acknowledgeAlert moves active→acknowledged; the still-true alert is NOT regenerated", async () => {
    const list = await listAlerts({ tripId });
    const target = list.items.find((a) => a.alertCase === "missed_origin_arrival")!;
    const ack = await acknowledgeAlert(target.id, actorId);
    expect(ack.state).toBe("acknowledged");

    // Re-generating while acknowledged-but-still-true ⇒ no new row (the partial-unique covers ack too).
    const regen = await generateAlert(db, tripId, "missed_origin_arrival", "high");
    expect(regen).toBe(false);
  });

  it("autoResolveAlert clears it; a later recurrence inserts a FRESH row (prior stays resolved)", async () => {
    const resolved = await autoResolveAlert(db, tripId, "missed_origin_arrival");
    expect(resolved).toBe(true);

    // The condition recurs ⇒ a fresh active row is inserted (the resolved row is outside the predicate).
    const regen = await generateAlert(db, tripId, "missed_origin_arrival", "high");
    expect(regen).toBe(true);

    // Two rows total for this case now: one resolved (history) + one active.
    const rows = await db
      .select({ state: alerts.state })
      .from(alerts)
      .where(eq(alerts.tripId, tripId));
    expect(rows.filter((r) => r.state === "resolved").length).toBeGreaterThanOrEqual(1);
    expect(rows.filter((r) => r.state === "active").length).toBe(1);
  });

  it("acknowledgeAlert on an already-resolved alert ⇒ STALE_ALERT", async () => {
    // Insert a one-off case, resolve it, then try to acknowledge the resolved row by id.
    await generateAlert(db, tripId, "missed_departure", "medium");
    const before = await listAlerts({ tripId });
    const dep = before.items.find((a) => a.alertCase === "missed_departure")!;
    await autoResolveAlert(db, tripId, "missed_departure");
    await expect(acknowledgeAlert(dep.id, actorId)).rejects.toMatchObject({ code: "STALE_ALERT" });
  });

  it("listAlerts excludes resolved rows and reports per-case/severity counts", async () => {
    const list = await listAlerts({ tripId });
    expect(list.items.every((a) => a.state === "active" || a.state === "acknowledged")).toBe(true);
    expect(list.counts.total).toBe(list.items.length);
    expect(typeof list.counts.bySeverity).toBe("object");
    void activeCount;
  });
});
