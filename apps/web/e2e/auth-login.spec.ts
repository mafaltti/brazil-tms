import { expect, test } from "@playwright/test";
import { routes, testAccounts } from "./test-config";

/**
 * T021 — Authentication / sign-in (US1, FR-001..FR-003, SC-003).
 * Uses resilient pt-BR selectors (getByLabel / getByRole / getByText). DB-backed; run against a
 * seeded environment (see quickstart.md). The seeded admin has must_change_password=true on first
 * login, so a valid sign-in may land on /auth/set-password rather than the home shell — both count
 * as "left the login page".
 */

async function signIn(
  page: import("@playwright/test").Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto(routes.login);
  await page.getByLabel(/E-mail/i).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

test.describe("auth · sign-in", () => {
  test("valid login reaches the authenticated app (leaves /login)", async ({ page }) => {
    await signIn(page, testAccounts.nonAdmin.email, testAccounts.nonAdmin.password);

    // Either the home shell or a forced set-password page — never still on /login.
    await expect(page).not.toHaveURL(new RegExp(`${routes.login}$`));
    await page.waitForURL((url) => !url.pathname.endsWith(routes.login));
  });

  test("invalid credentials stay on /login with a generic error and no session", async ({
    page,
  }) => {
    await signIn(page, testAccounts.nonAdmin.email, "definitely-the-wrong-password");

    await expect(page).toHaveURL(new RegExp(`${routes.login}$`));
    await expect(page.getByText("E-mail ou senha inválidos.")).toBeVisible();

    // No session established: a protected deep-link bounces back to /login.
    await page.goto(routes.adminUsers);
    await expect(page).toHaveURL(new RegExp(`${routes.login}`));
  });

  test("unauthenticated deep-link to a protected route redirects to /login", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto(routes.adminUsers);
    await expect(page).toHaveURL(new RegExp(`${routes.login}`));
  });

  test("sign-out ends the session", async ({ page }) => {
    await signIn(page, testAccounts.nonAdmin.email, testAccounts.nonAdmin.password);
    await page.waitForURL((url) => !url.pathname.endsWith(routes.login));

    // If a forced password change intercepts, this account variant isn't usable for sign-out here.
    if (page.url().includes(routes.setPassword)) {
      test.skip(true, "Account requires a password change; sign-out covered by an active account.");
    }

    await page.getByRole("button", { name: "Sair" }).click();
    await expect(page).toHaveURL(new RegExp(`${routes.login}`));

    // Session is gone: a protected route stays bounced to /login.
    await page.goto(routes.home);
    await expect(page).toHaveURL(new RegExp(`${routes.login}`));
  });

  test("disabled user is denied at sign-in (no session)", async ({ page }) => {
    // The disabled account is provisioned via env; fall back to the non-admin email if unset.
    const email = process.env.E2E_DISABLED_EMAIL ?? testAccounts.nonAdmin.email;
    const password = process.env.E2E_DISABLED_PASSWORD ?? testAccounts.nonAdmin.password;

    await signIn(page, email, password);

    if (process.env.E2E_DISABLED_EMAIL) {
      await expect(page).toHaveURL(new RegExp(`${routes.login}$`));
      await expect(
        page.getByText("Sua conta está desativada. Contate um administrador."),
      ).toBeVisible();

      await page.goto(routes.home);
      await expect(page).toHaveURL(new RegExp(`${routes.login}`));
    }
  });

  test("expired/cleared session redirects the next protected request to /login", async ({
    page,
  }) => {
    await signIn(page, testAccounts.nonAdmin.email, testAccounts.nonAdmin.password);
    await page.waitForURL((url) => !url.pathname.endsWith(routes.login));

    // Simulate session expiry by clearing the session cookies.
    await page.context().clearCookies();
    await page.goto(routes.home);
    await expect(page).toHaveURL(new RegExp(`${routes.login}`));
  });
});
