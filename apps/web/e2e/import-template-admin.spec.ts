import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { testAccounts, routes } from "./test-config";

/**
 * Slice 012 — Import Template Administration. The screen completes CUST-003 (in-app template config)
 * over the EXISTING `/api/import-templates` endpoints (gated by `import_trips` = Admin + Ops Manager).
 *
 * Authorization is the deterministic core: a role WITHOUT `import_trips` (Dispatcher) is 403 on the API
 * and redirected away from the screen. The UI flows exercise create → appears in the Trip Import
 * selector, the grouped target picker, and the two save-blocking rules (duplicate target / zero
 * mappings). Tests isolate via timestamped template names (no DB cleanup) against the seeded
 * `DEMO-SHOPEE` customer.
 */

const TEMPLATES = "/api/import-templates";
const SOME_UUID = "00000000-0000-0000-0000-000000000000";

const PT = {
  new: "Novo modelo",
  create: "Criar modelo",
  name: "Nome",
  version: "Versão",
  addMapping: "Adicionar mapeamento",
  removeMapping: "Remover",
  save: "Salvar",
  createdMsg: "Modelo criado com sucesso.",
  conflicting: "Este campo já está mapeado em outra linha.",
  atLeastOne: "Adicione ao menos um mapeamento de coluna.",
  // grouped target picker headers (FR-003)
  groups: ["Texto", "Data e Hora", "Número", "Estruturado"],
} as const;

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

/** Open a Radix Select by trigger id and click the option (matches the master-data e2e helper). */
async function selectOptionById(page: Page, triggerId: string, optionName: RegExp | string) {
  await page.locator(`#${triggerId}`).click();
  await page.getByRole("option", { name: optionName }).click();
}

/** Open the per-row target single-select (addressed by its aria-label) and pick a field. */
async function selectTarget(page: Page, rowIndex: number, fieldName: string) {
  await page.getByRole("combobox", { name: `Campo interno ${rowIndex + 1}` }).click();
  await page.getByRole("option", { name: fieldName, exact: true }).click();
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function gotoAdmin(page: Page): Promise<void> {
  await page.goto("/admin/import-templates");
  // Select the seeded DEMO-SHOPEE customer.
  await selectOptionById(page, "template-customer", /DEMO-SHOPEE/);
}

test.describe("US1 — authorization", () => {
  test("no session → 401 on the template endpoints", async ({ request }) => {
    expect((await request.get(`${TEMPLATES}?customerId=${SOME_UUID}`)).status()).toBe(401);
  });

  test("a role without import_trips (Dispatcher) → 403 on GET + POST", async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    await apiLogin(ctx, testAccounts.dispatcher);
    expect((await ctx.get(`${TEMPLATES}?customerId=${SOME_UUID}`)).status()).toBe(403);
    expect(
      (await ctx.post(TEMPLATES, { data: { customerId: SOME_UUID, name: "x", version: 1, fileType: "csv", columnMappings: [{ source: "a", target: "originCode" }], parsingRules: {}, requiredOverrides: [] } })).status(),
    ).toBe(403);
    await ctx.dispose();
  });

  test("Dispatcher is redirected away from /admin/import-templates", async ({ page }) => {
    await signIn(page, testAccounts.dispatcher);
    await page.goto("/admin/import-templates");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: /modelos de importação/i })).toHaveCount(0);
  });
});

test.describe("US1 — author a template in-app", () => {
  test("create a template → it appears in the admin list AND the Trip Import selector", async ({
    page,
  }) => {
    await signIn(page, testAccounts.admin);
    await gotoAdmin(page);

    const name = uniqueName("E2E-TPL");
    await page.getByRole("button", { name: PT.new }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(PT.name, { exact: true }).fill(name);
    await dialog.getByLabel(PT.version, { exact: true }).fill("1");
    // file type defaults to CSV; map one column to a recognized target.
    await dialog.getByLabel(/coluna do arquivo 1/i).fill("id_viagem");
    await selectTarget(page, 0, "externalTripId");
    await dialog.getByRole("button", { name: PT.create }).click();

    // Success + appears in the admin list.
    await expect(page.getByText(PT.createdMsg)).toBeVisible();
    await expect(page.getByRole("row", { name: new RegExp(name) })).toBeVisible();

    // Appears in the Trip Import selector for the same customer (active && !archived).
    await page.goto("/imports");
    await selectOptionById(page, "import-customer", /DEMO-SHOPEE/);
    await page.locator("#import-template").click();
    await expect(page.getByRole("option", { name: new RegExp(name) })).toBeVisible();
  });

  test("the target picker shows the four pt-BR kind groups", async ({ page }) => {
    await signIn(page, testAccounts.admin);
    await gotoAdmin(page);

    await page.getByRole("button", { name: PT.new }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("combobox", { name: "Campo interno 1" }).click();
    const listbox = page.getByRole("listbox");
    for (const group of PT.groups) {
      await expect(listbox.getByText(group, { exact: true })).toBeVisible();
    }
  });

  test("two rows mapping the same target block save with an inline hint", async ({ page }) => {
    await signIn(page, testAccounts.admin);
    await gotoAdmin(page);

    const name = uniqueName("E2E-DUP");
    await page.getByRole("button", { name: PT.new }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(PT.name, { exact: true }).fill(name);
    await dialog.getByLabel(/coluna do arquivo 1/i).fill("col_a");
    await selectTarget(page, 0, "originCode");
    await dialog.getByRole("button", { name: PT.addMapping }).click();
    await dialog.getByLabel(/coluna do arquivo 2/i).fill("col_b");
    await selectTarget(page, 1, "originCode");
    await dialog.getByRole("button", { name: PT.create }).click();

    await expect(dialog.getByText(PT.conflicting).first()).toBeVisible();
    // The dialog stays open (save was blocked).
    await expect(dialog).toBeVisible();
  });

  test("a template with zero mappings cannot be saved", async ({ page }) => {
    await signIn(page, testAccounts.admin);
    await gotoAdmin(page);

    const name = uniqueName("E2E-EMPTY");
    await page.getByRole("button", { name: PT.new }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(PT.name, { exact: true }).fill(name);
    // Remove the single default mapping row.
    await dialog.getByRole("button", { name: PT.removeMapping }).click();
    await dialog.getByRole("button", { name: PT.create }).click();

    await expect(dialog.getByText(PT.atLeastOne)).toBeVisible();
    await expect(dialog).toBeVisible();
  });
});
