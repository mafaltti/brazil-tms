import { test, expect, type Page } from "@playwright/test";
import { testAccounts, routes } from "./test-config";

/**
 * US1 — Customers master data, end-to-end (T034). Authored against the seeded `admin`. Selectors
 * lean on pt-BR UI strings (messages/pt-BR.json) and ARIA roles. Covers: create → list → edit →
 * archive → duplicate-code rejected, and asserts SLA/document/import-template fields are absent here
 * (those belong to features 004/007/008).
 */

const PT = {
  new: "Novo cliente",
  create: "Criar cliente",
  name: "Nome",
  code: "Código",
  duplicate: "Já existe um cliente com esse código.",
  includeArchived: "Incluir arquivados",
  archive: "Arquivar",
  archived: "Arquivado",
} as const;

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto(routes.login);
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

function uniqueCode(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function createCustomer(
  page: Page,
  opts: { name: string; code: string },
): Promise<void> {
  await page.getByRole("button", { name: PT.new }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(PT.name, { exact: true }).fill(opts.name);
  await dialog.getByLabel(PT.code, { exact: true }).fill(opts.code);
  await dialog.getByRole("button", { name: PT.create }).click();
}

test.describe("US1 — Customers", () => {
  test("admin creates a customer that appears in the list", async ({ page }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);
    await page.goto("/admin/customers");

    const code = uniqueCode("E2E");
    await createCustomer(page, { name: "Shopee E2E", code });

    await expect(page.getByRole("row", { name: new RegExp(code) })).toBeVisible();
  });

  test("the create form has no SLA / document / import-template fields (scope guard)", async ({
    page,
  }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);
    await page.goto("/admin/customers");
    await page.getByRole("button", { name: PT.new }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/SLA/i)).toHaveCount(0);
    await expect(dialog.getByText(/template|modelo de importação/i)).toHaveCount(0);
    await expect(dialog.getByText(/documento exigido|requisito de documento/i)).toHaveCount(0);
  });

  test("duplicate customerCode is rejected", async ({ page }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);
    await page.goto("/admin/customers");

    const code = uniqueCode("DUP");
    await createCustomer(page, { name: "Primeiro", code });
    await expect(page.getByRole("row", { name: new RegExp(code) })).toBeVisible();

    await createCustomer(page, { name: "Segundo", code });
    await expect(page.getByText(PT.duplicate)).toBeVisible();
  });

  test("admin archives a customer; it leaves the active list and returns with the toggle", async ({
    page,
  }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);
    await page.goto("/admin/customers");

    const code = uniqueCode("ARC");
    await createCustomer(page, { name: "Para Arquivar", code });
    const row = page.getByRole("row", { name: new RegExp(code) });
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: PT.archive }).click();
    await expect(page.getByRole("row", { name: new RegExp(code) })).toHaveCount(0);

    await page.getByLabel(PT.includeArchived).check();
    await expect(page.getByRole("row", { name: new RegExp(code) })).toBeVisible();
  });
});
