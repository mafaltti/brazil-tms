import { test, expect, type APIRequestContext } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";
import { customers, db, locations, trips, users } from "@brazil-tms/db";
import { dayRangeSaoPaulo } from "@brazil-tms/shared";
import { testAccounts } from "./test-config";

/**
 * US4 (Home daily dashboard) — drives `GET /api/dashboard/summary` against the running app (T0xx).
 * Asserts authorization (401 no session; 200 for an onboarded role holding `view_all_trips`) and the
 * §15.2 widget shape: `tripsTodayByStatus` + `billingPendingCount` are COMPUTED; the six later-slice
 * metrics are exactly `null` (006/007/008 placeholders).
 *
 * Self-seeds (a Playwright spec cannot import the `server-only` services): one customer + two
 * locations + an active trip whose pickup is pinned to today's São Paulo day (so it groups into
 * today regardless of host timezone) + a `billing_pending` trip. Requires DATABASE_URL for the test
 * process.
 *
 * Login: Ops Manager (`testAccounts.opsManager`). The summary is a system-wide aggregate, not scoped
 * to a single customer, so the assertions use ">= 1" / "defined" rather than exact counts (other
 * seeds in the shared dev DB may contribute today-trips).
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

let customerId = "";
let originId = "";
let destId = "";
const tripIds: string[] = [];

async function seedTrip(
  externalTripId: string,
  currentStatus: (typeof trips.$inferSelect)["currentStatus"],
  plannedPickupWindowStart: Date | null,
): Promise<string> {
  const inserted = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId,
      originLocationId: originId,
      destinationLocationId: destId,
      currentStatus,
      originalPlan: { customerId, originLocationId: originId, destinationLocationId: destId },
      plannedPickupWindowStart,
    })
    .returning({ id: trips.id });
  const id = inserted[0]!.id;
  tripIds.push(id);
  return id;
}

test.beforeAll(async () => {
  const admin = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, ADMIN_EMAIL))
    .limit(1);
  expect(admin[0]?.id, "seeded admin must exist (run db:seed)").toBeTruthy();

  const cust = await db
    .insert(customers)
    .values({ name: "Cliente Dashboard", customerCode: code("CUST") })
    .returning({ id: customers.id });
  customerId = cust[0]!.id;

  const origin = await db
    .insert(locations)
    .values({ customerId, code: code("ORIG"), name: "Origem Dashboard" })
    .returning({ id: locations.id });
  originId = origin[0]!.id;

  const dest = await db
    .insert(locations)
    .values({ customerId, code: code("DEST"), name: "Destino Dashboard" })
    .returning({ id: locations.id });
  destId = dest[0]!.id;

  // Pin the active trip's pickup to the middle of the current São Paulo day so it falls in today's
  // BRT window regardless of the host timezone.
  const { from } = dayRangeSaoPaulo(new Date());
  const todayMidday = new Date(new Date(from).getTime() + 12 * 60 * 60 * 1000);

  await seedTrip(code("EXT-TODAY"), "in_transit", todayMidday);
  await seedTrip(code("EXT-BILL"), "billing_pending", new Date("2026-06-04T08:00:00.000Z"));
});

test.afterAll(async () => {
  // FK-safe order: trips (no events/audit seeded here) → locations → customers.
  if (tripIds.length) await db.delete(trips).where(inArray(trips.id, tripIds));
  for (const id of [originId, destId]) {
    if (id) await db.delete(locations).where(eq(locations.id, id));
  }
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

test.describe("US4 — Home daily dashboard summary", () => {
  test("no session → GET /api/dashboard/summary is 401", async ({ request }) => {
    const res = await request.get("/api/dashboard/summary");
    expect(res.status()).toBe(401);
  });

  test("Ops Manager → 200 with computed today/billing counts and null later-slice metrics", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const res = await ctx.get("/api/dashboard/summary");
    expect(res.status()).toBe(200);
    const { summary } = (await res.json()) as {
      summary: {
        tripsTodayByStatus: Array<{ status: string; count: number }>;
        billingPendingCount: number;
        tripsAtRisk: number | null;
        unassignedTrips: number | null;
        activeExceptions: number | null;
        onTimePickupPct: number | null;
        onTimeArrivalPct: number | null;
        completedMissingDocuments: number | null;
      };
    };

    // Computed: the seeded today-trip's status appears with a count >= 1.
    expect(Array.isArray(summary.tripsTodayByStatus)).toBe(true);
    const todayInTransit = summary.tripsTodayByStatus.find((s) => s.status === "in_transit");
    expect(todayInTransit).toBeDefined();
    expect(todayInTransit!.count).toBeGreaterThanOrEqual(1);

    expect(summary.billingPendingCount).toBeGreaterThanOrEqual(1);

    // Every later-slice metric is exactly null (006/007/008 placeholders).
    expect(summary.tripsAtRisk).toBeNull();
    expect(summary.unassignedTrips).toBeNull();
    expect(summary.activeExceptions).toBeNull();
    expect(summary.onTimePickupPct).toBeNull();
    expect(summary.onTimeArrivalPct).toBeNull();
    expect(summary.completedMissingDocuments).toBeNull();
  });
});
