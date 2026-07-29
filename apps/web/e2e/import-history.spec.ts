import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { testAccounts, routes } from "./test-config";

/**
 * Feature 004 US5 — import batch history (T054). The history list surfaces every batch with its
 * metadata + the four counts + status (INT-004, FR-031). Authorization mirrors the rest of the
 * import surface (`import_trips`). Batch contents/idempotency are asserted by the worker tests; here
 * we verify the list endpoint + the history screen render for an authorized user.
 */

const IMPORTS = "/api/imports";

async function signIn(page: Page, account: { email: string; password: string }): Promise<void> {
  await page.goto(routes.login);
  await page.getByLabel(/e-?mail/i).fill(account.email);
  await page.getByLabel(/senha/i).fill(account.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith(routes.login), { timeout: 15_000 });
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

test("US5 — batch history list returns items with counts + status", async ({ request }) => {
  const ctx = await apiLogin(request, testAccounts.opsManager);
  const res = await ctx.get(`${IMPORTS}?limit=50`);
  expect(res.status()).toBe(200);
  const { items } = await res.json();
  expect(Array.isArray(items)).toBeTruthy();
  for (const b of items) {
    expect(b).toHaveProperty("status");
    expect(b).toHaveProperty("totalRows");
    expect(b).toHaveProperty("createdCount");
    expect(b).toHaveProperty("errorCount");
  }
});

test("US5 — history screen renders for an authorized user", async ({ page }) => {
  await signIn(page, testAccounts.opsManager);
  await page.goto("/imports/history");
  await expect(page.getByRole("heading", { name: /histórico/i })).toBeVisible();
});

test("US5 — history is denied to a role without import_trips", async ({ request }) => {
  const ctx = await apiLogin(request, testAccounts.dispatcher);
  expect((await ctx.get(`${IMPORTS}?limit=50`)).status()).toBe(403);
});
