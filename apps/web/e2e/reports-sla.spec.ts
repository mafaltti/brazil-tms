import { test, expect, type APIRequestContext } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";
import { customers, db, locations, trips } from "@brazil-tms/db";
import { testAccounts } from "./test-config";

/**
 * Feature 009 US1 — the SLA report endpoint + screen (contracts §1). Asserts the `view_all_trips`
 * holder gets `200` with the report shape, no session gets `401`, a default-policy customer is flagged
 * `provisional`, and the Reports → SLA screen renders. All seven internal roles hold `view_all_trips`
 * (no seeded non-holder), so the negative-permission `403` path is proven by `permission-coverage.spec.ts`
 * over the same `requirePermission` guard on keys that DO have a non-holder.
 */

async function apiLogin(
  request: APIRequestContext,
  account: { email: string; password: string },
): Promise<void> {
  const res = await request.post("/api/auth/sign-in", {
    data: { email: account.email, password: account.password },
  });
  expect(res.ok()).toBeTruthy();
}

function code(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

let customerId = "";
let originId = "";
let destId = "";
const tripIds: string[] = [];

test.beforeAll(async () => {
  const cust = await db
    .insert(customers)
    .values({ name: "Cliente Relatório SLA", customerCode: code("CUST") })
    .returning({ id: customers.id });
  customerId = cust[0]!.id;
  const origin = await db
    .insert(locations)
    .values({ customerId, code: code("ORIG"), name: "Origem Rel" })
    .returning({ id: locations.id });
  originId = origin[0]!.id;
  const dest = await db
    .insert(locations)
    .values({ customerId, code: code("DEST"), name: "Destino Rel" })
    .returning({ id: locations.id });
  destId = dest[0]!.id;
  // A May-2026 trip with no customer_sla_rules → the SLA report runs on the default policy (provisional).
  const trip = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId: code("EXT"),
      originLocationId: originId,
      destinationLocationId: destId,
      currentStatus: "in_transit",
      slaStatus: "on_track",
      originalPlan: { customerId, originLocationId: originId, destinationLocationId: destId },
      plannedPickupWindowStart: new Date("2026-05-12T08:00:00.000Z"),
      plannedPickupWindowEnd: new Date("2026-05-12T12:00:00.000Z"),
    })
    .returning({ id: trips.id });
  tripIds.push(trip[0]!.id);
});

test.afterAll(async () => {
  if (tripIds.length) await db.delete(trips).where(inArray(trips.id, tripIds));
  await db.delete(locations).where(inArray(locations.id, [originId, destId]));
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

test("no session → GET /api/reports/sla is 401", async ({ request }) => {
  const res = await request.get("/api/reports/sla");
  expect(res.status()).toBe(401);
});

test("view_all_trips holder → 200 with the SLA report shape", async ({ request }) => {
  await apiLogin(request, testAccounts.opsManager);
  const res = await request.get("/api/reports/sla");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    period: { from: string; to: string; label: string };
    totals: { total: number; breached: number };
    groups: unknown[];
    provisional: boolean;
  };
  expect(body.period?.label).toBeTruthy();
  expect(typeof body.totals?.total).toBe("number");
  expect(Array.isArray(body.groups)).toBe(true);
});

test("a default-policy customer is reported provisional", async ({ request }) => {
  await apiLogin(request, testAccounts.opsManager);
  const res = await request.get(
    `/api/reports/sla?customerId=${customerId}&from=2026-05-01&to=2026-05-31`,
  );
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { provisional: boolean; groups: { total: number }[] };
  expect(body.provisional).toBe(true);
  expect(body.groups[0]?.total).toBeGreaterThanOrEqual(1);
});

test("the Reports → SLA screen renders for a holder", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(testAccounts.opsManager.email);
  await page.getByLabel(/senha/i).fill(testAccounts.opsManager.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });

  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Relatórios" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "SLA" })).toBeVisible();
});
