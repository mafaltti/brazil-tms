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

/** Open a Radix Select by trigger id and click the option (matches the master-data e2e helper). The
 *  customer triggers are `disabled` until their query loads, so wait for enabled first — on a loaded
 *  local stack the fetch can take several seconds, and clicking a disabled trigger would otherwise burn
 *  the test budget. */
async function selectOptionById(page: Page, triggerId: string, optionName: RegExp | string) {
  const trigger = page.locator(`#${triggerId}`);
  await expect(trigger).toBeEnabled({ timeout: 20_000 });
  await trigger.click();
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

/** Create a template through the UI (one column mapping). Assumes the customer is already selected. */
async function createTemplateViaUI(
  page: Page,
  opts: { name: string; version?: number; source?: string; target?: string },
): Promise<void> {
  await page.getByRole("button", { name: PT.new }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(PT.name, { exact: true }).fill(opts.name);
  await dialog.getByLabel(PT.version, { exact: true }).fill(String(opts.version ?? 1));
  await dialog.getByLabel(/coluna do arquivo 1/i).fill(opts.source ?? "col_a");
  await selectTarget(page, 0, opts.target ?? "externalTripId");
  await dialog.getByRole("button", { name: PT.create }).click();
}

async function gotoAdmin(page: Page, customerCode: RegExp = /DEMO-SHOPEE/): Promise<void> {
  await page.goto("/admin/import-templates");
  await selectOptionById(page, "template-customer", customerCode);
}

/** Create an isolated customer via the API (admin holds manage_commercial_data) so the last-active
 *  flow can be tested deterministically — DEMO-SHOPEE always has the seeded template active. */
async function apiCreateCustomer(request: APIRequestContext): Promise<{ id: string; code: string }> {
  await apiLogin(request, testAccounts.admin);
  const code = `E2E-CUST-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const res = await request.post("/api/master-data/customers", {
    data: { name: `E2E Cust ${code}`, customerCode: code, contacts: [] },
  });
  expect(res.ok()).toBeTruthy();
  const id = (await res.json()).item.id as string;
  return { id, code };
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

test.describe("US2 — review, edit, and version templates", () => {
  test("edit a mapping → save → reopening shows the change", async ({ page }) => {
    await signIn(page, testAccounts.admin);
    await gotoAdmin(page);

    const name = uniqueName("E2E-EDIT");
    await createTemplateViaUI(page, { name, source: "orig_col", target: "originCode" });
    await expect(page.getByText(PT.createdMsg)).toBeVisible();

    const row = page.getByRole("row", { name: new RegExp(name) });
    await row.getByRole("button", { name: "Editar" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const source = dialog.getByLabel(/coluna do arquivo 1/i);
    await expect(source).toHaveValue("orig_col");
    await source.fill("orig_col_edited");
    await dialog.getByRole("button", { name: "Salvar", exact: true }).click();

    await expect(page.getByText("Modelo atualizado com sucesso.")).toBeVisible();
    // Wait for the post-save invalidate→refetch to land before reopening, so the row DTO seeding the
    // form reflects the persisted edit (the form seeds once on open; a stale row would show old data).
    await page.waitForLoadState("networkidle");
    await row.getByRole("button", { name: "Editar" }).click();
    await expect(page.getByRole("dialog").getByLabel(/coluna do arquivo 1/i)).toHaveValue(
      "orig_col_edited",
    );
  });

  test("Criar nova versão pre-fills version = max+1 and creates a distinct version", async ({
    page,
  }) => {
    await signIn(page, testAccounts.admin);
    await gotoAdmin(page);

    const name = uniqueName("E2E-VER");
    await createTemplateViaUI(page, { name, version: 1 });
    await expect(page.getByText(PT.createdMsg)).toBeVisible();

    const row = page.getByRole("row", { name: new RegExp(name) });
    await row.getByRole("button", { name: "Criar nova versão" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel(PT.version, { exact: true })).toHaveValue("2");
    await dialog.getByRole("button", { name: PT.create }).click();
    await expect(page.getByText(PT.createdMsg)).toBeVisible();

    // Both versions are now listed for that name.
    await expect(page.getByRole("row", { name: new RegExp(name) })).toHaveCount(2);
  });

  test("a duplicate (customer, name, version) shows the exact pt-BR duplicate message", async ({
    page,
  }) => {
    await signIn(page, testAccounts.admin);
    await gotoAdmin(page);

    const name = uniqueName("E2E-DUPKEY");
    await createTemplateViaUI(page, { name, version: 1 });
    await expect(page.getByText(PT.createdMsg)).toBeVisible();

    await createTemplateViaUI(page, { name, version: 1 });
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Já existe um modelo com esse nome e versão.")).toBeVisible();
    await expect(dialog).toBeVisible();
  });
});

test.describe("US3 — control template availability", () => {
  test("deactivate removes it from the Trip Import selector; reactivate restores it", async ({
    page,
  }) => {
    test.slow(); // heaviest test: 6 full-page navigations between /admin and /imports.
    await signIn(page, testAccounts.admin);
    await gotoAdmin(page); // DEMO-SHOPEE keeps the seeded template active, so this is not last-active.

    const name = uniqueName("E2E-LIFE");
    await createTemplateViaUI(page, { name });
    await expect(page.getByText(PT.createdMsg)).toBeVisible();

    // Present in the Trip Import selector.
    await page.goto("/imports");
    await selectOptionById(page, "import-customer", /DEMO-SHOPEE/);
    await page.locator("#import-template").click();
    await expect(page.getByRole("option", { name: new RegExp(name) })).toBeVisible();
    await page.keyboard.press("Escape");

    // Deactivate from the admin screen.
    await gotoAdmin(page);
    const row = page.getByRole("row", { name: new RegExp(name) });
    await row.getByRole("button", { name: "Desativar" }).click();
    await expect(page.getByText("Modelo desativado.")).toBeVisible();

    // Gone from the selector. Wait for the templates fetch to settle so the count-0 assertion is not
    // a false pass against a still-loading (momentarily empty) list.
    await page.goto("/imports");
    await selectOptionById(page, "import-customer", /DEMO-SHOPEE/);
    await page.waitForLoadState("networkidle");
    await page.locator("#import-template").click();
    await expect(page.getByRole("option", { name: new RegExp(name) })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Reactivate → returns to the selector.
    await gotoAdmin(page);
    await page.getByRole("row", { name: new RegExp(name) }).getByRole("button", { name: "Ativar" }).click();
    await expect(page.getByText("Modelo ativado.")).toBeVisible();
    await page.goto("/imports");
    await selectOptionById(page, "import-customer", /DEMO-SHOPEE/);
    await page.locator("#import-template").click();
    await expect(page.getByRole("option", { name: new RegExp(name) })).toBeVisible();
  });

  test("archive hides it from the active list; it returns (read-only) with Incluir arquivados", async ({
    page,
  }) => {
    await signIn(page, testAccounts.admin);
    await gotoAdmin(page);

    const name = uniqueName("E2E-ARCH");
    await createTemplateViaUI(page, { name });
    await expect(page.getByText(PT.createdMsg)).toBeVisible();

    await page
      .getByRole("row", { name: new RegExp(name) })
      .getByRole("button", { name: "Arquivar" })
      .click();
    await expect(page.getByText("Modelo arquivado.")).toBeVisible();
    await expect(page.getByRole("row", { name: new RegExp(name) })).toHaveCount(0);

    // Visible only with the toggle, and read-only (no Edit; view-only).
    await page.getByLabel("Incluir arquivados").check();
    const archivedRow = page.getByRole("row", { name: new RegExp(name) });
    await expect(archivedRow).toBeVisible();
    await expect(archivedRow.getByRole("button", { name: "Editar" })).toHaveCount(0);
    await expect(archivedRow.getByRole("button", { name: "Visualizar" })).toBeVisible();
  });

  test("deactivating the customer's last active template warns and allows proceed", async ({
    page,
    request,
  }) => {
    const { code } = await apiCreateCustomer(request);
    await signIn(page, testAccounts.admin);
    await gotoAdmin(page, new RegExp(code));

    const name = uniqueName("E2E-LAST");
    await createTemplateViaUI(page, { name });
    await expect(page.getByText(PT.createdMsg)).toBeVisible();

    const row = page.getByRole("row", { name: new RegExp(name) });
    await row.getByRole("button", { name: "Desativar" }).click();

    // The last-active confirmation appears; Prosseguir proceeds (warn-and-allow).
    await expect(page.getByText(/último modelo ativo deste cliente/i)).toBeVisible();
    await page.getByRole("button", { name: "Prosseguir" }).click();
    await expect(page.getByText("Modelo desativado.")).toBeVisible();
    await expect(
      page.getByRole("row", { name: new RegExp(name) }).getByRole("button", { name: "Ativar" }),
    ).toBeVisible();
  });
});

test.describe("review fixes — required projection + archived-aware versioning", () => {
  test("a mapping marked Obrigatório is persisted into requiredOverrides (what the worker enforces)", async ({
    page,
    request,
  }) => {
    await signIn(page, testAccounts.admin);
    await gotoAdmin(page);

    const name = uniqueName("E2E-REQ");
    await page.getByRole("button", { name: PT.new }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(PT.name, { exact: true }).fill(name);
    await dialog.getByLabel(/coluna do arquivo 1/i).fill("id_col");
    await selectTarget(page, 0, "externalTripId");
    await dialog.getByRole("checkbox").first().check();
    await dialog.getByRole("button", { name: PT.create }).click();
    await expect(page.getByText(PT.createdMsg)).toBeVisible();

    // The worker enforces required-ness only via requiredOverrides — assert the checkbox landed there.
    await apiLogin(request, testAccounts.admin);
    const customers = await (await request.get("/api/master-data/customers")).json();
    const demo = customers.items.find(
      (c: { customerCode: string }) => c.customerCode === "DEMO-SHOPEE",
    );
    const list = await (
      await request.get(`/api/import-templates?customerId=${demo.id}`)
    ).json();
    const created = list.items.find((t: { name: string }) => t.name === name);
    expect(created.requiredOverrides).toContain("externalTripId");
  });

  test("Criar nova versão skips an archived version number (no duplicate-key collision)", async ({
    page,
  }) => {
    await signIn(page, testAccounts.admin);
    await gotoAdmin(page);

    const name = uniqueName("E2E-ARCHVER");
    await createTemplateViaUI(page, { name, version: 1 });
    await expect(page.getByText(PT.createdMsg)).toBeVisible();

    // Make v2, then archive it (v1 + the seed stay active, so no last-active prompt).
    await page
      .getByRole("row", { name: new RegExp(name) })
      .getByRole("button", { name: "Criar nova versão" })
      .click();
    let dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel(PT.version, { exact: true })).toHaveValue("2");
    await dialog.getByRole("button", { name: PT.create }).click();
    await expect(page.getByText(PT.createdMsg)).toBeVisible();

    await page
      .getByRole("row", { name: new RegExp(name) })
      .filter({ hasText: "v2" })
      .getByRole("button", { name: "Arquivar" })
      .click();
    await expect(page.getByText("Modelo arquivado.")).toBeVisible();

    // v2 is now archived (hidden by default). A new version off v1 must suggest 3, not the colliding 2.
    await page
      .getByRole("row", { name: new RegExp(name) })
      .filter({ hasText: "v1" })
      .getByRole("button", { name: "Criar nova versão" })
      .click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel(PT.version, { exact: true })).toHaveValue("3");
  });
});
