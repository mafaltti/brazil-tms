import { test, expect, type Page } from "@playwright/test";
import { testAccounts, routes } from "./test-config";

/**
 * US3 (Users & Roles administration) + US4 audit wiring, end-to-end.
 *
 * These specs are AUTHORED but not run here. They assume the seeded `admin` and `nonAdmin`
 * accounts from test-config and a clean DB per run. Selectors lean on the pt-BR UI strings
 * (messages/pt-BR.json) and ARIA roles so they survive markup tweaks.
 */

const PT = {
  newUser: "Novo usuário",
  createUser: "Criar usuário",
  name: "Nome",
  email: "E-mail",
  role: "Perfil",
  onboarding: "Forma de acesso",
  onboardingInvite: "Enviar convite por e-mail",
  onboardingTempPassword: "Definir senha temporária",
  tempPassword: "Senha temporária",
  enable: "Ativar",
  disable: "Desativar",
  resendInvite: "Reenviar convite",
  duplicateEmail: "Já existe um usuário com esse e-mail.",
  lastAdminGuard: "Não é possível desativar ou rebaixar o último administrador ativo.",
  notPending: "O usuário não está pendente.",
} as const;

/** Sign in through the login form and land on the authenticated shell. */
async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto(routes.login);
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

/** A unique email so repeated runs never collide. Avoid '+' (a regex metachar used in row matches). */
function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/** Open the create dialog, fill the shared fields, and pick the onboarding method. */
async function fillCreateForm(
  page: Page,
  opts: { name: string; email: string; method: "invite" | "temp_password"; tempPassword?: string },
): Promise<void> {
  await page.getByRole("button", { name: PT.newUser }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(PT.name).fill(opts.name);
  await dialog.getByLabel(PT.email).fill(opts.email);

  // Onboarding method (Radix Select): open via the trigger id, pick the option (rendered in a
  // portal at body level), then wait for the method switch to settle.
  await dialog.locator("#method").click();
  const label = opts.method === "invite" ? PT.onboardingInvite : PT.onboardingTempPassword;
  await page.getByRole("option", { name: label, exact: true }).click();

  if (opts.method === "temp_password") {
    const tempField = dialog.getByLabel(PT.tempPassword);
    await tempField.waitFor({ state: "visible" });
    await tempField.fill(opts.tempPassword ?? "");
  }
}

test.describe("US3 — Users & Roles administration", () => {
  test("admin creates a user via invite (status pending)", async ({ page }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);
    await page.goto(routes.adminUsers);

    const email = uniqueEmail("invite");
    await fillCreateForm(page, { name: "Convidado Teste", email, method: "invite" });
    await page.getByRole("button", { name: PT.createUser }).click();

    const row = page.getByRole("row", { name: new RegExp(email) });
    await expect(row).toBeVisible();
    // Pending users expose the "Reenviar convite" action.
    await expect(row.getByRole("button", { name: PT.resendInvite })).toBeVisible();
  });

  test("admin creates a user with temp password (forced change on first login)", async ({
    page,
    browser,
  }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);
    await page.goto(routes.adminUsers);

    const email = uniqueEmail("temp");
    const tempPassword = "TempPass!2026";
    await fillCreateForm(page, {
      name: "Senha Temporária",
      email,
      method: "temp_password",
      tempPassword,
    });
    await page.getByRole("button", { name: PT.createUser }).click();
    await expect(page.getByRole("row", { name: new RegExp(email) })).toBeVisible();

    // First sign-in is forced to the set-password flow (FR-013a).
    const fresh = await browser.newContext();
    const freshPage = await fresh.newPage();
    await login(freshPage, email, tempPassword);
    await expect(freshPage).toHaveURL(/\/auth\/set-password/);
    await fresh.close();
  });

  test("admin can resend an invite for a pending user", async ({ page }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);
    await page.goto(routes.adminUsers);

    const email = uniqueEmail("resend");
    await fillCreateForm(page, { name: "Reenvio Teste", email, method: "invite" });
    await page.getByRole("button", { name: PT.createUser }).click();

    const row = page.getByRole("row", { name: new RegExp(email) });
    await row.getByRole("button", { name: PT.resendInvite }).click();
    await expect(page.getByText("Convite enviado.")).toBeVisible();
  });

  test("resending an invite for a non-pending user is rejected", async ({ request }) => {
    // Drive the API directly with the admin session cookies.
    const ctx = await loginViaApi(request, testAccounts.admin.email, testAccounts.admin.password);
    const list = await ctx.get("/api/admin/users");
    const { users } = (await list.json()) as { users: Array<{ id: string; status: string }> };
    const active = users.find((u) => u.status === "active");
    expect(active).toBeTruthy();

    const res = await ctx.post(`/api/admin/users/${active!.id}/invite`);
    expect(res.status()).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_PENDING");
  });

  test("admin can change a user's role and status", async ({ page }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);
    await page.goto(routes.adminUsers);

    const email = uniqueEmail("rolechange");
    await fillCreateForm(page, {
      name: "Mudança Perfil",
      email,
      method: "temp_password",
      tempPassword: "TempPass!2026",
    });
    await page.getByRole("button", { name: PT.createUser }).click();

    const row = page.getByRole("row", { name: new RegExp(email) });
    await expect(row).toBeVisible();

    // Change role via the in-row Select.
    await row.getByLabel("Alterar perfil").click();
    await page.getByRole("option", { name: "Despachante" }).click();
    await expect(page.getByText("Usuário atualizado.")).toBeVisible();

    // Disable the user.
    await row.getByRole("button", { name: PT.disable }).click();
    await expect(row.getByText("Desativado")).toBeVisible();
  });

  test("duplicate email is rejected", async ({ page }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);
    await page.goto(routes.adminUsers);

    await fillCreateForm(page, {
      name: "Duplicado",
      email: testAccounts.admin.email,
      method: "invite",
    });
    await page.getByRole("button", { name: PT.createUser }).click();
    await expect(page.getByText(PT.duplicateEmail)).toBeVisible();
  });
});

test.describe("US3 — authorization", () => {
  test("non-admin is redirected away from /admin/users (UI)", async ({ page }) => {
    await login(page, testAccounts.nonAdmin.email, testAccounts.nonAdmin.password);
    await page.goto(routes.adminUsers);
    // The server guard redirects a user without manage_users to home.
    await expect(page).toHaveURL((url) => url.pathname === "/");
  });

  test("non-admin GET /api/admin/users returns 403 (API)", async ({ request }) => {
    const ctx = await loginViaApi(
      request,
      testAccounts.nonAdmin.email,
      testAccounts.nonAdmin.password,
    );
    const res = await ctx.get("/api/admin/users");
    expect(res.status()).toBe(403);
  });
});

test.describe("US3 — last-admin guard (FR-016)", () => {
  test("disabling the last active admin is rejected (UI)", async ({ page }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);
    await page.goto(routes.adminUsers);

    const row = page.getByRole("row", { name: new RegExp(testAccounts.admin.email) });
    await row.getByRole("button", { name: PT.disable }).click();
    await expect(page.getByText(PT.lastAdminGuard)).toBeVisible();
  });

  test("down-roling the last active admin is rejected (API)", async ({ request }) => {
    const ctx = await loginViaApi(request, testAccounts.admin.email, testAccounts.admin.password);
    const list = await ctx.get("/api/admin/users");
    const { users } = (await list.json()) as { users: Array<{ id: string; email: string }> };
    const self = users.find((u) => u.email === testAccounts.admin.email);
    expect(self).toBeTruthy();

    const res = await ctx.patch(`/api/admin/users/${self!.id}`, {
      data: { role: "finance" },
    });
    expect(res.status()).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("LAST_ADMIN_GUARD");
  });
});

test.describe("US3 — changes take effect on next request (SC-007)", () => {
  test("disabling a signed-in user denies their next request", async ({ browser, request }) => {
    // Admin creates a disposable active user.
    const adminCtx = await loginViaApi(
      request,
      testAccounts.admin.email,
      testAccounts.admin.password,
    );
    const email = uniqueEmail("disable-live");
    const password = "TempPass!2026";
    const created = await adminCtx.post("/api/admin/users", {
      data: {
        name: "Sessão Ativa",
        email,
        role: "finance",
        onboarding: { method: "temp_password", tempPassword: password },
      },
    });
    expect(created.status()).toBe(201);
    const { user } = (await created.json()) as { user: { id: string } };

    // That user signs in (their own browser context).
    const userContext = await browser.newContext();
    const userPage = await userContext.newPage();
    await login(userPage, email, password);
    // They are forced to set a password; complete it so they hold a live session.
    if (userPage.url().includes("/auth/set-password")) {
      await userPage.getByLabel("Nova senha").fill("NewPass!2026");
      await userPage.getByLabel("Confirmar senha").fill("NewPass!2026");
      await userPage.getByRole("button", { name: "Salvar senha" }).click();
      await userPage.waitForURL((url) => !url.pathname.includes("/auth/set-password"));
    }

    // Admin disables them.
    const disabled = await adminCtx.patch(`/api/admin/users/${user.id}`, {
      data: { status: "disabled" },
    });
    expect(disabled.ok()).toBeTruthy();

    // Next navigation for the disabled user is bounced to /login (session re-evaluated).
    await userPage.goto(routes.home);
    await expect(userPage).toHaveURL(/\/login/);
    await userContext.close();
  });

  test("role change is reflected on the user's next request", async ({ browser, request }) => {
    const adminCtx = await loginViaApi(
      request,
      testAccounts.admin.email,
      testAccounts.admin.password,
    );
    const email = uniqueEmail("role-live");
    const password = "TempPass!2026";
    const created = await adminCtx.post("/api/admin/users", {
      data: {
        name: "Perfil Vivo",
        email,
        role: "finance",
        onboarding: { method: "temp_password", tempPassword: password },
      },
    });
    expect(created.status()).toBe(201);
    const { user } = (await created.json()) as { user: { id: string } };

    const userContext = await browser.newContext();
    const userPage = await userContext.newPage();
    await login(userPage, email, password);
    if (userPage.url().includes("/auth/set-password")) {
      await userPage.getByLabel("Nova senha").fill("NewPass!2026");
      await userPage.getByLabel("Confirmar senha").fill("NewPass!2026");
      await userPage.getByRole("button", { name: "Salvar senha" }).click();
      await userPage.waitForURL((url) => !url.pathname.includes("/auth/set-password"));
    }

    // Finance has no manage_users → /admin/users redirects home.
    await userPage.goto(routes.adminUsers);
    await expect(userPage).toHaveURL((url) => url.pathname === "/");

    // Promote to admin; next request gains the area.
    const promoted = await adminCtx.patch(`/api/admin/users/${user.id}`, {
      data: { role: "admin" },
    });
    expect(promoted.ok()).toBeTruthy();

    await userPage.goto(routes.adminUsers);
    await expect(userPage).toHaveURL(/\/admin\/users/);
    await userContext.close();
  });
});

/**
 * Build an APIRequestContext that carries a signed-in user's session cookies by signing in via the
 * BFF and reusing the same `request` fixture (cookies persist on it).
 */
async function loginViaApi(
  request: import("@playwright/test").APIRequestContext,
  email: string,
  password: string,
): Promise<import("@playwright/test").APIRequestContext> {
  const res = await request.post("/api/auth/sign-in", { data: { email, password } });
  expect(res.ok()).toBeTruthy();
  return request;
}
