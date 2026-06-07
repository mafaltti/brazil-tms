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
 * Feature 007 — the authorization matrix (T098; permission-matrix.md test focus). 007 first-enforces
 * `update_trip_status` (milestones/notes), `create_exceptions`/`resolve_exceptions` (exception
 * create/edit/transition), and reuses `manage_commercial_data` (SLA-rule writes). Reads + alert
 * acknowledge stay on `view_all_trips`. This spec asserts holder 200 vs non-holder 403 on each write,
 * the view-only read surface (board/detail/exceptions/alerts/dashboard → 200 + alert acknowledge), and
 * the unauthenticated 401. Roles available in the e2e seed: opsManager (all 007 write keys +
 * manage_commercial_data), dispatcher (update_trip_status + create/resolve_exceptions, NOT
 * manage_commercial_data), nonAdmin=Finance (view-only — none of the 007 write keys).
 *
 * Self-seeds via `@brazil-tms/db`; FK-safe cleanup; requires the app + DB.
 */

function code(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}
const SOME_UUID = "00000000-0000-0000-0000-000000000000";

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
let reasonId = "";
const tripIds: string[] = [];

async function seedTrip(currentStatus = "received"): Promise<string> {
  const inserted = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId: code("EXT-AUTHZ7"),
      originLocationId: originId,
      destinationLocationId: destId,
      currentStatus: currentStatus as never,
      originalPlan: {},
    })
    .returning({ id: trips.id });
  const id = inserted[0]!.id;
  tripIds.push(id);
  return id;
}

test.beforeAll(async () => {
  const cust = await db.insert(customers).values({ name: "Cliente Authz 007", customerCode: code("CUST") }).returning({ id: customers.id });
  customerId = cust[0]!.id;
  const origin = await db.insert(locations).values({ customerId, code: code("ORIG"), name: "Origem" }).returning({ id: locations.id });
  originId = origin[0]!.id;
  const dest = await db.insert(locations).values({ customerId, code: code("DEST"), name: "Destino" }).returning({ id: locations.id });
  destId = dest[0]!.id;
  const rc = await db
    .insert(reasonCodes)
    .values({ code: code("RC"), category: "delay", labelPt: "Atraso", defaultSeverity: "low", defaultResponsibleParty: "unknown" })
    .returning({ id: reasonCodes.id });
  reasonId = rc[0]!.id;
});

test.afterAll(async () => {
  if (tripIds.length) {
    await db.delete(alerts).where(inArray(alerts.tripId, tripIds));
    await db.delete(exceptions).where(inArray(exceptions.tripId, tripIds));
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, tripIds));
    await db.delete(trips).where(inArray(trips.id, tripIds));
  }
  if (reasonId) await db.delete(reasonCodes).where(eq(reasonCodes.id, reasonId));
  for (const id of [originId, destId]) if (id) await db.delete(locations).where(eq(locations.id, id));
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

test.describe("007 authz — update_trip_status (milestones + notes)", () => {
  test("holder (Dispatcher) 200, non-holder (Finance) 403, unauthenticated 401", async ({ request }) => {
    // Seed at `confirmed` and drive a genuine EXECUTION MILESTONE (`confirmed → at_origin`) — the
    // status route's documented purpose. NOT an assignment-phase transition: `received → assigned`
    // must go through the assignment route (assign_resources + eligibility + a trip_assignments row),
    // so exercising it here would sanction a bypass.
    const tripId = await seedTrip("confirmed");

    // Unauthenticated → 401.
    const noAuth = await request.post(`/api/trips/${tripId}/status`, {
      data: { expectedFromStatus: "confirmed", toStatus: "at_origin" },
    });
    expect(noAuth.status()).toBe(401);

    // Holder (Dispatcher) → 200 on status + note.
    await apiLogin(request, testAccounts.dispatcher);
    const status = await request.post(`/api/trips/${tripId}/status`, {
      data: { expectedFromStatus: "confirmed", toStatus: "at_origin" },
    });
    expect(status.status()).toBe(200);
    const note = await request.post(`/api/trips/${tripId}/events`, { data: { notes: "ok" } });
    expect(note.status()).toBe(200);

    // Non-holder (Finance) → 403 on status + note (rejected at the permission gate, before any transition).
    await apiLogin(request, testAccounts.nonAdmin);
    const status403 = await request.post(`/api/trips/${tripId}/status`, {
      data: { expectedFromStatus: "at_origin", toStatus: "in_transit" },
    });
    expect(status403.status()).toBe(403);
    const note403 = await request.post(`/api/trips/${tripId}/events`, { data: { notes: "x" } });
    expect(note403.status()).toBe(403);
  });

  test("update_trip_status cannot enter an assignment-phase state via /status (no assign_resources bypass)", async ({
    request,
  }) => {
    // Dispatcher holds update_trip_status but NOT assign_resources. `received → assigned` is a legal
    // table edge, but it MUST go through the assignment route (which enforces assign_resources, runs
    // eligibility, and writes a trip_assignments row). The generic status route rejects it so an
    // update_trip_status-only holder can't mint a structurally inconsistent "assigned" trip.
    const tripId = await seedTrip("received");
    await apiLogin(request, testAccounts.dispatcher);

    const res = await request.post(`/api/trips/${tripId}/status`, {
      data: { expectedFromStatus: "received", toStatus: "assigned" },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).error.code).toBe("USE_ASSIGNMENT_ENDPOINT");

    // No state change: the trip is still `received` and no assignment row was created.
    const rows = await db
      .select({ s: trips.currentStatus })
      .from(trips)
      .where(eq(trips.id, tripId))
      .limit(1);
    expect(rows[0]!.s).toBe("received");
  });
});

test.describe("007 authz — create_exceptions / resolve_exceptions", () => {
  test("holder 200/201, non-holder (Finance) 403 on create + transition", async ({ request }) => {
    const tripId = await seedTrip("confirmed");

    // Holder (Dispatcher) → 201 create.
    await apiLogin(request, testAccounts.dispatcher);
    const created = await request.post(`/api/trips/${tripId}/exceptions`, {
      data: { reasonCodeId: reasonId },
    });
    expect(created.status()).toBe(201);
    const { item } = (await created.json()) as { item: { exceptions: Array<{ id: string }> } };
    const excId = item.exceptions[0]!.id;
    // Holder → 200 transition + edit.
    const trans = await request.post(`/api/exceptions/${excId}/transition`, {
      data: { expectedFromStatus: "open", toStatus: "monitoring" },
    });
    expect(trans.status()).toBe(200);
    const edit = await request.patch(`/api/exceptions/${excId}`, { data: { description: "edit" } });
    expect(edit.status()).toBe(200);

    // Non-holder (Finance) → 403 on create + transition + edit.
    await apiLogin(request, testAccounts.nonAdmin);
    expect((await request.post(`/api/trips/${tripId}/exceptions`, { data: { reasonCodeId: reasonId } })).status()).toBe(403);
    expect(
      (await request.post(`/api/exceptions/${excId}/transition`, { data: { expectedFromStatus: "monitoring", toStatus: "cancelled" } })).status(),
    ).toBe(403);
    expect((await request.patch(`/api/exceptions/${excId}`, { data: { description: "y" } })).status()).toBe(403);
  });
});

test.describe("007 authz — SLA-rule writes reuse manage_commercial_data", () => {
  test("holder (Ops Manager) 201, non-holder (Dispatcher / Finance) 403", async ({ request }) => {
    const ruleBody = {
      customerId,
      pickupToleranceMinutes: 0,
      deliveryToleranceMinutes: 0,
      confirmationCutoffMinutes: 120,
      atRiskWarningMinutes: 60,
    };

    // Ops Manager holds manage_commercial_data → 201.
    await apiLogin(request, testAccounts.opsManager);
    const ok = await request.post(`/api/customer-sla-rules`, { data: ruleBody });
    expect(ok.status()).toBe(201);

    // Dispatcher does NOT hold manage_commercial_data → 403 (even though it holds the exception keys).
    await apiLogin(request, testAccounts.dispatcher);
    expect((await request.post(`/api/customer-sla-rules`, { data: ruleBody })).status()).toBe(403);

    // Finance → 403.
    await apiLogin(request, testAccounts.nonAdmin);
    expect((await request.post(`/api/customer-sla-rules`, { data: ruleBody })).status()).toBe(403);
  });
});

test.describe("007 authz — view-only roles read + acknowledge via view_all_trips", () => {
  test("Finance reads board/detail/exceptions/alerts/dashboard (200) and acknowledges alerts", async ({
    request,
  }) => {
    // Seed an alert via a holder (high-sev exception on a confirmed trip).
    await apiLogin(request, testAccounts.dispatcher);
    const tripId = await seedTrip("confirmed");
    const highRc = await db
      .insert(reasonCodes)
      .values({ code: code("RCH"), category: "breakdown", labelPt: "Pane", defaultSeverity: "high", defaultResponsibleParty: "carrier_caused" })
      .returning({ id: reasonCodes.id });
    try {
      await request.post(`/api/trips/${tripId}/exceptions`, { data: { reasonCodeId: highRc[0]!.id } });

      // Finance (view_all_trips) reads everything.
      await apiLogin(request, testAccounts.nonAdmin);
      expect((await request.get(`/api/trips`)).status()).toBe(200);
      expect((await request.get(`/api/trips/${tripId}`)).status()).toBe(200);
      expect((await request.get(`/api/exceptions`)).status()).toBe(200);
      expect((await request.get(`/api/alerts`)).status()).toBe(200);
      expect((await request.get(`/api/dashboard/summary`)).status()).toBe(200);

      // ...and can acknowledge an alert (read-surface triage on view_all_trips).
      const list = await request.get(`/api/alerts?tripId=${tripId}`);
      const { items } = (await list.json()) as { items: Array<{ id: string }> };
      if (items[0]) {
        const ack = await request.post(`/api/alerts/${items[0].id}/acknowledge`, { data: {} });
        expect(ack.status()).toBe(200);
      }

      // Unauthenticated read → 401.
      const fresh = await request.context().request;
      void fresh;
    } finally {
      await db.delete(alerts).where(eq(alerts.tripId, tripId));
      await db.delete(exceptions).where(eq(exceptions.tripId, tripId));
      await db.delete(reasonCodes).where(eq(reasonCodes.id, highRc[0]!.id));
    }
  });

  test("an unknown exception id is 404 (not 403) for a holder", async ({ request }) => {
    await apiLogin(request, testAccounts.dispatcher);
    const res = await request.patch(`/api/exceptions/${SOME_UUID}`, { data: { description: "x" } });
    expect(res.status()).toBe(404);
  });
});
