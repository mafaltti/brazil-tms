import { test, expect, type Page } from "@playwright/test";
import { testAccounts, routes } from "./test-config";

/**
 * US4 — Carriers master data, end-to-end. Authored against the seeded `admin`. Selectors lean on
 * pt-BR UI strings (messages/pt-BR.json, Resources.carriers.*) and ARIA roles. Covers: create →
 * list → archive → duplicate-CNPJ rejected. The taxId (CNPJ) is the unique natural key here (there
 * is no per-carrier code), so the list rows are matched on the unique CNPJ digits.
 */

const PT = {
  new: "Nova transportadora",
  create: "Criar transportadora",
  name: "Nome",
  taxId: "CNPJ",
  duplicate: "Já existe uma transportadora com esse CNPJ.",
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

/** Unique 14-digit CNPJ per run (the carrier's unique natural key). */
function uniqueCnpj(): string {
  const digits = `${Date.now()}${Math.floor(Math.random() * 1e6)}`.padStart(14, "0");
  return digits.slice(-14);
}

async function createCarrier(
  page: Page,
  opts: { name: string; taxId: string },
): Promise<void> {
  await page.getByRole("button", { name: PT.new }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(PT.name, { exact: true }).fill(opts.name);
  await dialog.getByLabel(PT.taxId, { exact: true }).fill(opts.taxId);
  await dialog.getByRole("button", { name: PT.create }).click();
}

test.describe("US4 — Carriers", () => {
  test("admin creates a carrier that appears in the list", async ({ page }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);
    await page.goto("/resources/carriers");

    const taxId = uniqueCnpj();
    await createCarrier(page, { name: "Transportadora E2E", taxId });

    await expect(page.getByRole("row", { name: new RegExp(taxId) })).toBeVisible();
  });

  test("duplicate taxId (CNPJ) is rejected", async ({ page }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);
    await page.goto("/resources/carriers");

    const taxId = uniqueCnpj();
    await createCarrier(page, { name: "Primeira", taxId });
    await expect(page.getByRole("row", { name: new RegExp(taxId) })).toBeVisible();

    await createCarrier(page, { name: "Segunda", taxId });
    await expect(page.getByText(PT.duplicate)).toBeVisible();
  });

  test("admin archives a carrier; it leaves the active list and returns with the toggle", async ({
    page,
  }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);
    await page.goto("/resources/carriers");

    const taxId = uniqueCnpj();
    await createCarrier(page, { name: "Para Arquivar", taxId });
    const row = page.getByRole("row", { name: new RegExp(taxId) });
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: PT.archive }).click();
    await expect(page.getByRole("row", { name: new RegExp(taxId) })).toHaveCount(0);

    await page.getByLabel(PT.includeArchived).check();
    await expect(page.getByRole("row", { name: new RegExp(taxId) })).toBeVisible();
  });
});
