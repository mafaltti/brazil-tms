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
 * Feature 007 US4 — in-app alerts e2e (HTTP-level). A high-severity exception (US2) raises its alert
 * synchronously; the alert surfaces on `GET /api/alerts` with counts; acknowledging removes it from
 * the active list (state → acknowledged) and a re-acknowledge of the same row stays acknowledged. The
 * two deferred §17 cases produce nothing. In-app only — no external channel. Self-seeds; FK-safe.
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

async function seedTrip(): Promise<string> {
  const inserted = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId: code("EXT-ALR"),
      originLocationId: originId,
      destinationLocationId: destId,
      currentStatus: "confirmed",
      originalPlan: {},
      // Future window so NO time-based alert fires — isolate the high-severity-exception alert.
      plannedPickupWindowStart: new Date("2999-01-01T08:00:00.000Z"),
      plannedPickupWindowEnd: new Date("2999-01-01T10:00:00.000Z"),
    })
    .returning({ id: trips.id });
  const id = inserted[0]!.id;
  tripIds.push(id);
  return id;
}

test.beforeAll(async () => {
  const cust = await db.insert(customers).values({ name: "Cliente Alerts E2E", customerCode: code("CUST") }).returning({ id: customers.id });
  customerId = cust[0]!.id;
  const origin = await db.insert(locations).values({ customerId, code: code("ORIG"), name: "Origem Alr" }).returning({ id: locations.id });
  originId = origin[0]!.id;
  const dest = await db.insert(locations).values({ customerId, code: code("DEST"), name: "Destino Alr" }).returning({ id: locations.id });
  destId = dest[0]!.id;
  const rc = await db
    .insert(reasonCodes)
    .values({ code: code("RC"), category: "breakdown", labelPt: "Pane Alr", defaultSeverity: "high", defaultResponsibleParty: "carrier_caused" })
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

test.describe("007 US4 — in-app alerts", () => {
  test("a high-severity exception raises its alert; it surfaces on /api/alerts with counts", async ({
    request,
  }) => {
    await apiLogin(request, testAccounts.dispatcher);
    const tripId = await seedTrip();
    await request.post(`/api/trips/${tripId}/exceptions`, { data: { reasonCodeId: highReasonId } });

    const list = await request.get(`/api/alerts?tripId=${tripId}`);
    expect(list.ok()).toBeTruthy();
    const { items, counts } = (await list.json()) as {
      items: Array<{ id: string; alertCase: string; state: string }>;
      counts: { total: number; bySeverity: Record<string, number> };
    };
    const hi = items.find((a) => a.alertCase === "high_severity_exception")!;
    expect(hi).toBeTruthy();
    expect(hi.state).toBe("active");
    expect(counts.total).toBeGreaterThanOrEqual(1);
    expect(counts.bySeverity.high).toBeGreaterThanOrEqual(1);
    // The two deferred cases produce nothing.
    expect(items.some((a) => a.alertCase === "completed_missing_documents")).toBe(false);
    expect(items.some((a) => a.alertCase === "billing_blocked_missing_proof")).toBe(false);
  });

  test("acknowledging an alert moves it to acknowledged (via view_all_trips, no write key)", async ({
    request,
  }) => {
    await apiLogin(request, testAccounts.dispatcher);
    const tripId = await seedTrip();
    await request.post(`/api/trips/${tripId}/exceptions`, { data: { reasonCodeId: highReasonId } });

    const list = await request.get(`/api/alerts?tripId=${tripId}`);
    const { items } = (await list.json()) as { items: Array<{ id: string; alertCase: string }> };
    const hi = items.find((a) => a.alertCase === "high_severity_exception")!;

    const ack = await request.post(`/api/alerts/${hi.id}/acknowledge`, { data: {} });
    expect(ack.ok()).toBeTruthy();
    const { item } = (await ack.json()) as { item: { state: string } };
    expect(item.state).toBe("acknowledged");

    // Finance (view-only) can also acknowledge — acknowledgement is read-surface triage (view_all_trips).
    await apiLogin(request, testAccounts.nonAdmin);
    const reAck = await request.post(`/api/alerts/${hi.id}/acknowledge`, { data: {} });
    expect(reAck.ok()).toBeTruthy();
  });

  test("unauthenticated → 401 on the alert list", async ({ request }) => {
    const res = await request.get(`/api/alerts`);
    expect(res.status()).toBe(401);
  });
});
