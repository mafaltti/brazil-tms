import { test, expect, type APIRequestContext } from "@playwright/test";
import { eq } from "drizzle-orm";
import { auditLogs, customers, db, locations, tripEvents, trips, users } from "@brazil-tms/db";
import { testAccounts } from "./test-config";

/**
 * US1 — trip read-only inspector authorization + payload shape (T023). Drives the two BFF read
 * endpoints against the running app and asserts the returned `TripDetail` shape (events + audit +
 * derived billingStatus).
 *
 * NOTE (005 re-gate): the trip READ endpoints (`GET /api/trips`, `GET /api/trips/:id`) are now gated
 * on `view_all_trips` — held by ALL seven internal roles — instead of `manage_trips`. So Finance, an
 * authenticated internal role, now READS the trip (200); there is no internal role that is denied the
 * read, so the only meaningful denial for reads is the 401 (no session). Editing still requires
 * `manage_trips` (covered by trip-detail.spec.ts).
 *
 * The fixture is SELF-SEEDED directly via `@brazil-tms/db` (NOT the `server-only` services, which a
 * Playwright spec cannot import): one customer + two locations + one trip with an immutable
 * `original_plan`, one `status_change` trip_event, and one `trip.status_change` audit row. Requires
 * DATABASE_URL to be set for the test process (the same local dev DB the app uses).
 *
 * Login choices:
 *  - The authorized case uses Operations Manager (`testAccounts.opsManager`) — a fully-onboarded
 *    e2e-seeded role. The seeded Admin is `must_change_password=true`, so an API-only sign-in would
 *    hit the onboarding gate (403) before any protected route; Ops Manager avoids that.
 *  - The Finance case (`testAccounts.nonAdmin`) now demonstrates the 005 re-gate: read access granted.
 */

const ADMIN_EMAIL = "admin@braziltransports.com.br";

function code(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function apiLogin(
  request: APIRequestContext,
  account: { email: string; password: string },
): Promise<APIRequestContext> {
  const res = await request.post("/api/auth/sign-in", {
    data: { email: account.email, password: account.password },
  });
  expect(res.ok()).toBeTruthy();
  return request;
}

let tripId = "";
let customerId = "";
let originId = "";
let destId = "";

test.beforeAll(async () => {
  const admin = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, ADMIN_EMAIL))
    .limit(1);
  const actorId = admin[0]?.id ?? "";
  expect(actorId, "seeded admin must exist (run db:seed)").not.toBe("");

  const cust = await db
    .insert(customers)
    .values({ name: "Cliente Inspetor", customerCode: code("CUST") })
    .returning();
  customerId = cust[0]!.id;

  const origin = await db
    .insert(locations)
    .values({ customerId, code: code("ORIG"), name: "Origem" })
    .returning();
  originId = origin[0]!.id;

  const dest = await db
    .insert(locations)
    .values({ customerId, code: code("DEST"), name: "Destino" })
    .returning();
  destId = dest[0]!.id;

  const originalPlan = {
    customerId,
    originLocationId: originId,
    destinationLocationId: destId,
    plannedVehicleType: "truck",
  };

  const trip = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId: code("EXT"),
      originLocationId: originId,
      destinationLocationId: destId,
      currentStatus: "received",
      originalPlan,
      plannedVehicleType: "truck",
    })
    .returning();
  tripId = trip[0]!.id;

  // A realistic status-change history row for the inspector to render: the trip was assigned and then
  // returned to `received` (the slice-015 unassign edge `assigned → received`), so the current status is
  // `received` again. The inspector test only asserts a status_change event + a trip.status_change audit
  // exist and that currentStatus is `received` — but a legal before/after pair keeps the fixture honest.
  await db.insert(tripEvents).values({
    tripId,
    eventType: "status_change",
    statusBefore: "assigned",
    statusAfter: "received",
    source: "system",
    actorUserId: actorId,
    eventTimestamp: new Date(),
  });

  await db.insert(auditLogs).values({
    entityType: "trip",
    entityId: tripId,
    action: "trip.status_change",
    previousValue: { currentStatus: "assigned" },
    newValue: { currentStatus: "received" },
    actorUserId: actorId,
  });
});

test.afterAll(async () => {
  // FK-safe order: trip_events + audit → trips → locations → customers.
  if (tripId) {
    await db.delete(tripEvents).where(eq(tripEvents.tripId, tripId));
    await db.delete(auditLogs).where(eq(auditLogs.entityId, tripId));
    await db.delete(trips).where(eq(trips.id, tripId));
  }
  for (const id of [originId, destId]) {
    if (id) await db.delete(locations).where(eq(locations.id, id));
  }
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

test.describe("US1 — trip inspector authorization + payload", () => {
  test("no session → GET /api/trips/:id is 401", async ({ request }) => {
    const res = await request.get(`/api/trips/${tripId}`);
    expect(res.status()).toBe(401);
  });

  test("authenticated Finance (view_all_trips, 005 re-gate) → 200 read access", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.nonAdmin);
    const res = await ctx.get(`/api/trips/${tripId}`);
    expect(res.status()).toBe(200);
    const { item } = (await res.json()) as { item: { id: string } };
    expect(item.id).toBe(tripId);
  });

  test("authorized (Ops Manager) → 200 with the trip detail (events + audit + billingStatus)", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);

    const detailRes = await ctx.get(`/api/trips/${tripId}`);
    expect(detailRes.status()).toBe(200);
    const { item } = (await detailRes.json()) as {
      item: {
        id: string;
        currentStatus: string;
        billingStatus: string | null;
        originalPlan: unknown;
        events: Array<{ eventType: string }>;
        audit: Array<{ action: string }>;
      };
    };
    expect(item.id).toBe(tripId);
    expect(item.currentStatus).toBe("received");
    // `received` is not a billing-phase status → the derived projection is null.
    expect(item.billingStatus).toBeNull();
    expect(item.originalPlan).toBeTruthy();
    expect(item.events.some((e) => e.eventType === "status_change")).toBe(true);
    expect(item.audit.some((a) => a.action === "trip.status_change")).toBe(true);

    // The list endpoint surfaces the same trip.
    const listRes = await ctx.get("/api/trips");
    expect(listRes.status()).toBe(200);
    const { items } = (await listRes.json()) as { items: Array<{ id: string }> };
    expect(items.some((t) => t.id === tripId)).toBe(true);
  });
});
