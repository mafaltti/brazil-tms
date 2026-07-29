import { expect, test } from "@playwright/test";
import { routes, testAccounts } from "./test-config";

/**
 * T022 — Password flows (US1, FR-004, FR-013a).
 * forgot-password is always answered neutrally (no account-existence disclosure); the set-password
 * landing renders; a temp-password user is forced to /auth/set-password on first sign-in.
 */

test.describe("auth · password flows", () => {
  test("forgot-password for an unknown e-mail shows the neutral response (no disclosure)", async ({
    page,
  }) => {
    await page.goto(routes.forgotPassword);
    await page.getByLabel(/E-mail/i).fill("nobody-here-xyz@example.com");
    await page.getByRole("button", { name: "Enviar link" }).click();

    await expect(
      page.getByText(
        "Se houver uma conta com esse e-mail, enviaremos instruções para redefinir a senha.",
      ),
    ).toBeVisible();
  });

  test("set-password landing renders the form", async ({ page }) => {
    await page.goto(routes.setPassword);

    await expect(page.getByText("Por segurança, defina uma nova senha para continuar.")).toBeVisible();
    await expect(page.getByLabel("Nova senha", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Confirmar senha", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Salvar senha" })).toBeVisible();
  });

  test("forced password change on first sign-in lands on /auth/set-password", async ({ page }) => {
    // A dedicated temp-password account (must_change_password=true) — see test-config / quickstart.
    await page.goto(routes.login);
    await page.getByLabel(/E-mail/i).fill(testAccounts.tempPassword.email);
    await page.getByLabel("Senha", { exact: true }).fill(testAccounts.tempPassword.password);
    await page.getByRole("button", { name: "Entrar" }).click();

    await expect(page).toHaveURL(new RegExp(`${routes.setPassword}`));
    await expect(page.getByText("Por segurança, defina uma nova senha para continuar.")).toBeVisible();
  });
});
