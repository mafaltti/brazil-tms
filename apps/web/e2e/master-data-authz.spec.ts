import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { testAccounts, routes } from "./test-config";

/**
 * US5 — master-data authorization (T075, T076). Verifies the cross-cutting permission split holds
 * uniformly: Dispatcher has NO master-data access (nav hidden + API 403, no state change);
 * Fleet Coordinator manages fleet but is 403 on commercial; Ops Manager manages both; archive
 * (DELETE) is Admin-only (a non-Admin gets 403). Authored against the e2e-seeded role accounts.
 */

const COMMERCIAL = "/api/master-data/customers";
const FLEET = "/api/master-data/drivers";
const SOME_UUID = "00000000-0000-0000-0000-000000000000";

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

test.describe("US5 — Dispatcher has no master-data access", () => {
  test("master-data nav is hidden for a Dispatcher", async ({ page }) => {
    await signIn(page, testAccounts.dispatcher);
    await page.goto(routes.home);
    const nav = page.getByRole("navigation");
    for (const label of [/clientes/i, /motoristas/i, /transportadoras/i, /rotas/i]) {
      await expect(nav.getByRole("link", { name: label })).toHaveCount(0);
    }
  });

  test("Dispatcher direct writes to commercial and fleet endpoints are 403 (no state change)", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.dispatcher);

    expect((await ctx.get(COMMERCIAL)).status()).toBe(403);
    expect((await ctx.get(FLEET)).status()).toBe(403);

    const postCommercial = await ctx.post(COMMERCIAL, {
      data: { name: "Negado", customerCode: `DENY-${Date.now()}`, contacts: [] },
    });
    expect(postCommercial.status()).toBe(403);

    const postFleet = await ctx.post(FLEET, {
      data: { name: "Negado", ownershipType: "owned" },
    });
    expect(postFleet.status()).toBe(403);

    expect((await ctx.delete(`${COMMERCIAL}/${SOME_UUID}`)).status()).toBe(403);
  });
});

test.describe("US5 — role split (commercial vs fleet)", () => {
  test("Fleet Coordinator manages fleet but is 403 on commercial", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.fleetCoord);
    expect((await ctx.get(FLEET)).status()).toBe(200);
    expect((await ctx.get("/api/master-data/carriers")).status()).toBe(200);
    expect((await ctx.get(COMMERCIAL)).status()).toBe(403);
    expect((await ctx.get("/api/master-data/lanes")).status()).toBe(403);
    // ...and cannot create commercial data.
    const post = await ctx.post(COMMERCIAL, {
      data: { name: "X", customerCode: `FC-${Date.now()}`, contacts: [] },
    });
    expect(post.status()).toBe(403);
  });

  test("Operations Manager manages both commercial and fleet", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    expect((await ctx.get(COMMERCIAL)).status()).toBe(200);
    expect((await ctx.get(FLEET)).status()).toBe(200);
  });

  test("archive (DELETE) by a non-Admin is 403 (delete_archive is Admin-only)", async ({
    request,
  }) => {
    const ops = await apiLogin(request, testAccounts.opsManager);
    // Ops Manager can read/write commercial data but NOT archive it.
    expect((await ops.delete(`${COMMERCIAL}/${SOME_UUID}`)).status()).toBe(403);
  });
});
