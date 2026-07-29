import { test, expect, type APIRequestContext } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";
import {
  alerts,
  auditLogs,
  customers,
  db,
  exceptions,
  locations,
  reasonCodes,
  trips,
} from "@brazil-tms/db";
import { testAccounts } from "./test-config";

/**
 * Feature 007 US3 — SLA-risk visibility e2e (HTTP-level). Seeds trips that hit representative triggers,
 * recomputes via the in-mutation path (creating a high-severity exception), and asserts the
 * server-authoritative `slaStatus`/`slaReasons` surface on the board row, the "At risk" board view,
 * Trip Detail, and the dashboard at-risk count. The UI never computes risk — every value comes from
 * the server reads. Self-seeds via `@brazil-tms/db`; FK-safe cleanup; requires the app + DB.
 */

function code(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function apiLogin(
  request: APIRequestContext,
  account: { email: string; password: string },
): Promise<void> {
  const res = await request.post("/api/auth/sign-in", {
    data: { email: account.email, password: account.password },
  });
  expect(res.ok()).toBeTruthy();
}

let customerId = "";
let originId = "";
let destId = "";
let highReasonId = "";
const tripIds: string[] = [];

/** A `confirmed` trip well past its pickup window (a late, server-flagged trip). */
async function seedLateTrip(): Promise<string> {
  const inserted = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId: code("EXT-SLA"),
      originLocationId: originId,
      destinationLocationId: destId,
      currentStatus: "confirmed",
      originalPlan: {},
      plannedPickupWindowStart: new Date("2020-01-01T08:00:00.000Z"),
      plannedPickupWindowEnd: new Date("2020-01-01T10:00:00.000Z"),
    })
    .returning({ id: trips.id });
  const id = inserted[0]!.id;
  tripIds.push(id);
  return id;
}

test.beforeAll(async () => {
  const cust = await db.insert(customers).values({ name: "Cliente SLA E2E", customerCode: code("CUST") }).returning({ id: customers.id });
  customerId = cust[0]!.id;
  const origin = await db.insert(locations).values({ customerId, code: code("ORIG"), name: "Origem SLA" }).returning({ id: locations.id });
  originId = origin[0]!.id;
  const dest = await db.insert(locations).values({ customerId, code: code("DEST"), name: "Destino SLA" }).returning({ id: locations.id });
  destId = dest[0]!.id;
  const rc = await db
    .insert(reasonCodes)
    .values({ code: code("RC"), category: "breakdown", labelPt: "Pane SLA", defaultSeverity: "high", defaultResponsibleParty: "carrier_caused" })
    .returning({ id: reasonCodes.id });
  highReasonId = rc[0]!.id;
});

test.afterAll(async () => {
  if (tripIds.length) {
    await db.delete(alerts).where(inArray(alerts.tripId, tripIds));
    await db.delete(exceptions).where(inArray(exceptions.tripId, tripIds));
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, tripIds));
    await db.delete(trips).where(inArray(trips.id, tripIds));
  }
  if (highReasonId) await db.delete(reasonCodes).where(eq(reasonCodes.id, highReasonId));
  for (const id of [originId, destId]) if (id) await db.delete(locations).where(eq(locations.id, id));
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

test.describe("007 US3 — server-authoritative SLA risk", () => {
  test("a high-severity exception drives the trip to at_risk on Trip Detail (server-computed)", async ({
    request,
  }) => {
    await apiLogin(request, testAccounts.dispatcher);
    const tripId = await seedLateTrip();

    // Creating the high-severity exception recomputes SLA in the mutation tx → worst-state-wins (Late
    // window-miss + At Risk exception ⇒ Late, both reasons).
    await request.post(`/api/trips/${tripId}/exceptions`, { data: { reasonCodeId: highReasonId } });

    const detail = await request.get(`/api/trips/${tripId}`);
    const { item } = (await detail.json()) as { item: { slaStatus: string; slaReasons: string[] } };
    expect(item.slaStatus).toBe("late");
    expect(item.slaReasons).toContain("delayed_origin_arrival");
    expect(item.slaReasons).toContain("open_high_severity_exception");
    expect(item.slaStatus).not.toBe("breached"); // never produced in MVP
  });

  test("the board row + the 'At risk' view + the dashboard count reflect the server SLA state", async ({
    request,
  }) => {
    await apiLogin(request, testAccounts.dispatcher);
    const tripId = await seedLateTrip();
    await request.post(`/api/trips/${tripId}/exceptions`, { data: { reasonCodeId: highReasonId } });

    // Board row carries slaStatus/slaReasons.
    const board = await request.get(`/api/trips?customerId=${customerId}&scope=active`);
    const { items } = (await board.json()) as {
      items: Array<{ id: string; slaStatus: string | null; slaReasons: string[] | null }>;
    };
    const row = items.find((r) => r.id === tripId)!;
    expect(row.slaStatus).toBe("late");
    expect(row.slaReasons).toContain("delayed_origin_arrival");

    // The "At risk" view (atRisk=true ⇒ at_risk|late|breached) includes it.
    const atRisk = await request.get(`/api/trips?customerId=${customerId}&atRisk=true&scope=active`);
    const { items: atRiskItems } = (await atRisk.json()) as { items: Array<{ id: string }> };
    expect(atRiskItems.some((r) => r.id === tripId)).toBe(true);

    // The dashboard at-risk count is a number (filled by 007).
    const summary = await request.get("/api/dashboard/summary");
    const { summary: s } = (await summary.json()) as { summary: { tripsAtRisk: number | null } };
    expect(typeof s.tripsAtRisk).toBe("number");
    expect(s.tripsAtRisk!).toBeGreaterThanOrEqual(1);
  });
});
