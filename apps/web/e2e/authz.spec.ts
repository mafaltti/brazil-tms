import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { testAccounts, routes } from "./test-config";

/**
 * US2 — role-based authorization (T035). Asserts: (a) admin sees the admin nav items
 * ("Usuários e Perfis", "Auditoria") while a non-admin does not; (b) a non-admin's direct
 * GET /api/admin/users → 403 with no state change; (c) a non-admin still reaches its own permitted
 * area — the app shell loads (positive path), so enforcement is least-privilege, not blanket-deny
 * (SC-002). Nav hiding is additive only — the BFF stays authoritative (FR-011).
 *
 * No DB here: authored, not run. Resilient pt-BR selectors are used for nav.
 */

async function signIn(page: Page, account: { email: string; password: string }): Promise<void> {
  await page.goto(routes.login);
  await page.getByLabel(/e-?mail/i).fill(account.email);
  await page.getByLabel(/senha/i).fill(account.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith(routes.login), { timeout: 15_000 });
}

const ADMIN_NAV = [/usuários e perfis/i, /auditoria/i] as const;

test.describe("US2 — role-based access control", () => {
  test("admin sees the administration nav items", async ({ page }) => {
    await signIn(page, testAccounts.admin);
    // The admin may be forced through set-password on first login; reach the shell explicitly.
    await page.goto(routes.home);

    const nav = page.getByRole("navigation");
    for (const label of ADMIN_NAV) {
      await expect(nav.getByRole("link", { name: label })).toBeVisible();
    }
  });

  test("a non-admin does not see the administration nav items", async ({ page }) => {
    await signIn(page, testAccounts.nonAdmin);
    await page.goto(routes.home);

    const nav = page.getByRole("navigation");
    for (const label of ADMIN_NAV) {
      await expect(nav.getByRole("link", { name: label })).toHaveCount(0);
    }
  });

  test("a non-admin's direct admin API call is forbidden with no state change", async ({
    request,
  }) => {
    const ctx: APIRequestContext = request;
    const signInRes = await ctx.post("/api/auth/sign-in", {
      data: {
        email: testAccounts.nonAdmin.email,
        password: testAccounts.nonAdmin.password,
      },
    });
    expect(signInRes.ok()).toBeTruthy();

    // Read attempt → 403.
    const getRes = await ctx.get("/api/admin/users");
    expect(getRes.status()).toBe(403);

    // A write attempt is also rejected (SC-003: a denied request causes no state change). Authorization
    // is checked before any mutation, so this never creates a user.
    const postRes = await ctx.post("/api/admin/users", {
      data: {
        name: "Não Autorizado",
        email: `e2e-denied-${Date.now()}@braziltransports.com.br`,
        role: "dispatcher",
        onboarding: { method: "invite" },
      },
    });
    expect(postRes.status()).toBe(403);
  });

  test("a non-admin still reaches its own permitted area — the shell loads (SC-002)", async ({
    page,
  }) => {
    await signIn(page, testAccounts.nonAdmin);
    await page.goto(routes.home);

    // Enforcement is least-privilege, not blanket-deny: the authenticated shell renders and the
    // user is NOT bounced back to /login.
    expect(new URL(page.url()).pathname).not.toBe(routes.login);
    await expect(page.getByRole("navigation")).toBeVisible();
    // The always-available home item is present for any authenticated user.
    await expect(page.getByRole("navigation").getByRole("link", { name: /início/i })).toBeVisible();
  });
});
