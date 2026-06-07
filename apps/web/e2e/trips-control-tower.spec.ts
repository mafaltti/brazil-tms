import { test, expect, type APIRequestContext } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";
import { customers, db, locations, trips, users } from "@brazil-tms/db";
import { dayRangeSaoPaulo } from "@brazil-tms/shared";
import { testAccounts } from "./test-config";

/**
 * US1 (Trip Control Tower board) + US5 (CSV export) — server-side filter/sort/paginate authorization
 * and shapes, driven against the running app (T0xx). Asserts the `GET /api/trips` board (default
 * active scope, status/customer/q/billingStatus filters, AND-combination) and the synchronous capped
 * `GET /api/trips/export` (text/csv + UTF-8 BOM).
 *
 * 005 RE-GATE: the trip READ endpoints are gated on `view_all_trips` — held by ALL seven internal
 * roles — so every onboarded role READS the board (200). The only read denial is `401` (no session).
 * Edits require `manage_trips` (covered by trip-detail.spec.ts), not exercised here.
 *
 * The fixture is SELF-SEEDED directly via `@brazil-tms/db` (a Playwright spec cannot import the
 * `server-only` services): one customer + two locations + four trips of differing statuses, one with
 * a `plannedPickupWindowStart` pinned to today's São Paulo day. Requires DATABASE_URL for the test
 * process (the same local dev DB the app uses).
 *
 * Login choices: authorized/read cases use Operations Manager (`testAccounts.opsManager`), a
 * fully-onboarded e2e-seeded role (the seeded Admin is `must_change_password=true`, so an API-only
 * sign-in would hit the onboarding gate before any protected route). The Finance case
 * (`testAccounts.nonAdmin`) demonstrates the re-gate: read access granted.
 */

const ADMIN_EMAIL = "admin@braziltransports.com.br";
const BOM = "﻿";

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

// Distinct trips captured for FK-safe cleanup + per-test assertions.
let inTransitId = "";
let receivedId = "";
let completedId = "";
let billingPendingId = "";
const tripIds: string[] = [];

// Unique external ids so parallel/repeat runs and other seeds never collide with the `q` query.
const extInTransit = code("EXT-IT");
const extValidated = code("EXT-VAL");
const extCompleted = code("EXT-DONE");
const extBilling = code("EXT-BILL");

async function seedTrip(
  externalTripId: string,
  currentStatus: (typeof trips.$inferSelect)["currentStatus"],
  plannedPickupWindowStart: Date | null,
): Promise<string> {
  const originalPlan = {
    customerId,
    originLocationId: originId,
    destinationLocationId: destId,
    plannedVehicleType: "truck",
  };
  const inserted = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId,
      originLocationId: originId,
      destinationLocationId: destId,
      currentStatus,
      originalPlan,
      plannedVehicleType: "truck",
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
    .values({ name: "Cliente Control Tower", customerCode: code("CUST") })
    .returning({ id: customers.id });
  customerId = cust[0]!.id;

  const origin = await db
    .insert(locations)
    .values({ customerId, code: code("ORIG"), name: "Origem CT" })
    .returning({ id: locations.id });
  originId = origin[0]!.id;

  const dest = await db
    .insert(locations)
    .values({ customerId, code: code("DEST"), name: "Destino CT" })
    .returning({ id: locations.id });
  destId = dest[0]!.id;

  // Pin one active trip's pickup to the middle of the current São Paulo day so it counts as "today"
  // regardless of the host timezone.
  const { from } = dayRangeSaoPaulo(new Date());
  const todayMidday = new Date(new Date(from).getTime() + 12 * 60 * 60 * 1000);

  inTransitId = await seedTrip(extInTransit, "in_transit", todayMidday);
  receivedId = await seedTrip(extValidated, "received", new Date("2026-06-02T08:00:00.000Z"));
  completedId = await seedTrip(extCompleted, "completed", new Date("2026-06-03T08:00:00.000Z"));
  billingPendingId = await seedTrip(
    extBilling,
    "billing_pending",
    new Date("2026-06-04T08:00:00.000Z"),
  );
});

test.afterAll(async () => {
  // FK-safe order: trips (no events/audit seeded here) → locations → customers.
  if (tripIds.length) await db.delete(trips).where(inArray(trips.id, tripIds));
  for (const id of [originId, destId]) {
    if (id) await db.delete(locations).where(eq(locations.id, id));
  }
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

test.describe("US1 — Trip Control Tower board (authorization + filters)", () => {
  test("no session → GET /api/trips is 401", async ({ request }) => {
    const res = await request.get("/api/trips");
    expect(res.status()).toBe(401);
  });

  test("Finance (view_all_trips, 005 re-gate) → GET /api/trips is 200", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.nonAdmin);
    const res = await ctx.get("/api/trips");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe("number");
  });

  test("default board (scope=active) returns active trips and excludes completed/billing", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const res = await ctx.get(`/api/trips?customerId=${customerId}`);
    expect(res.status()).toBe(200);
    const { items, total } = (await res.json()) as {
      items: Array<{ id: string }>;
      total: number;
    };
    const ids = items.map((t) => t.id);
    expect(ids).toContain(inTransitId);
    expect(ids).toContain(receivedId);
    expect(ids).not.toContain(completedId);
    expect(ids).not.toContain(billingPendingId);
    expect(typeof total).toBe("number");
  });

  test("?status=in_transit returns only that status", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const res = await ctx.get(`/api/trips?customerId=${customerId}&status=in_transit`);
    expect(res.status()).toBe(200);
    const { items } = (await res.json()) as {
      items: Array<{ id: string; currentStatus: string }>;
    };
    expect(items.every((t) => t.currentStatus === "in_transit")).toBe(true);
    const ids = items.map((t) => t.id);
    expect(ids).toContain(inTransitId);
    expect(ids).not.toContain(receivedId);
  });

  test("AND combo (customerId + status) narrows correctly", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const res = await ctx.get(`/api/trips?customerId=${customerId}&status=received`);
    expect(res.status()).toBe(200);
    const { items } = (await res.json()) as {
      items: Array<{ id: string; customerId: string; currentStatus: string }>;
    };
    expect(items.map((t) => t.id)).toEqual([receivedId]);
    expect(items.every((t) => t.customerId === customerId)).toBe(true);
  });

  test("?q=<externalTripId> surfaces the matching trip", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const res = await ctx.get(`/api/trips?q=${encodeURIComponent(extInTransit)}`);
    expect(res.status()).toBe(200);
    const { items } = (await res.json()) as {
      items: Array<{ id: string; externalTripId: string | null }>;
    };
    expect(items.map((t) => t.id)).toEqual([inTransitId]);
  });

  test("?billingStatus=billing_pending&scope=all returns the billing_pending trip", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const res = await ctx.get(
      `/api/trips?customerId=${customerId}&billingStatus=billing_pending&scope=all`,
    );
    expect(res.status()).toBe(200);
    const { items } = (await res.json()) as {
      items: Array<{ id: string; billingStatus: string | null }>;
    };
    const ids = items.map((t) => t.id);
    expect(ids).toContain(billingPendingId);
    expect(items.every((t) => t.billingStatus === "billing_pending")).toBe(true);
  });
});

test.describe("US5 — synchronous capped CSV export", () => {
  test("export → 200 text/csv with a UTF-8 BOM and a seeded external id", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const res = await ctx.get(`/api/trips/export?customerId=${customerId}&scope=all`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    const body = await res.text();
    expect(body.startsWith(BOM)).toBe(true);
    expect(body).toContain(extInTransit);
  });

  test("changing the filter changes the body", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);

    const allRes = await ctx.get(`/api/trips/export?customerId=${customerId}&scope=all`);
    expect(allRes.status()).toBe(200);
    const allBody = await allRes.text();

    // Narrow to a single status → the export no longer carries the other trips' external ids.
    const oneRes = await ctx.get(
      `/api/trips/export?customerId=${customerId}&status=received&scope=all`,
    );
    expect(oneRes.status()).toBe(200);
    const oneBody = await oneRes.text();

    expect(oneBody).not.toBe(allBody);
    expect(oneBody).toContain(extValidated);
    expect(oneBody).not.toContain(extInTransit);
  });

  // The over-cap path (matching row count > 10000 → 422 EXPORT_TOO_LARGE) is covered by the
  // trips-read integration test (`exportTripRows(query, 0)` throws Conflict("EXPORT_TOO_LARGE"),
  // which the route maps to 422). We do NOT seed >10k rows at the e2e layer.
  test.skip("export over-cap → 422 EXPORT_TOO_LARGE", () => {
    // Intentionally skipped — see comment above. Covered by apps/web/lib/trips/trips-read.test.ts.
  });
});
