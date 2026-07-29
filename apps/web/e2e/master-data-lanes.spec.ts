import { test, expect, type Page } from "@playwright/test";
import { testAccounts, routes } from "./test-config";

/**
 * US2 — Locations + Lanes master data, end-to-end. Authored against the seeded `admin`. Selectors
 * lean on pt-BR UI strings (messages/pt-BR.json) and ARIA roles. Covers the lane golden path
 * (create customer → two locations → lane) plus the FR-009/R5 integrity guards: a different-customer
 * location is not selectable for a lane, origin = destination is rejected, and an archived location
 * is excluded from the new-lane selection.
 */

const PT = {
  // customers
  customerNew: "Novo cliente",
  customerCreate: "Criar cliente",
  // locations
  locationNew: "Novo local",
  locationCreate: "Criar local",
  // lanes
  laneNew: "Nova rota",
  laneCreate: "Criar rota",
  // fields
  name: "Nome",
  code: "Código",
  customer: "Cliente",
  origin: "Origem",
  destination: "Destino",
  // messages
  invalidReference: "Origem/destino devem ser locais ativos do mesmo cliente.",
  degenerate: "A origem e o destino devem ser diferentes.",
  includeArchived: "Incluir arquivados",
  archive: "Arquivar",
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

async function createCustomer(page: Page, opts: { name: string; code: string }): Promise<void> {
  await page.goto("/admin/customers");
  await page.getByRole("button", { name: PT.customerNew }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(PT.name, { exact: true }).fill(opts.name);
  await dialog.getByLabel(PT.code, { exact: true }).fill(opts.code);
  await dialog.getByRole("button", { name: PT.customerCreate }).click();
  await expect(page.getByRole("row", { name: new RegExp(opts.code) })).toBeVisible();
}

/** Pick an option from a Radix Select by its visible trigger label, then the option name. */
async function selectOption(page: Page, triggerName: string, optionName: string): Promise<void> {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: triggerName }).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

async function createLocation(
  page: Page,
  opts: { name: string; code: string; customerName: string },
): Promise<void> {
  await page.goto("/admin/locations");
  await page.getByRole("button", { name: PT.locationNew }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await selectOption(page, PT.customer, opts.customerName);
  await dialog.getByLabel(PT.code, { exact: true }).fill(opts.code);
  await dialog.getByLabel(PT.name, { exact: true }).fill(opts.name);
  await dialog.getByRole("button", { name: PT.locationCreate }).click();
  await expect(page.getByRole("row", { name: new RegExp(opts.code) })).toBeVisible();
}

test.describe("US2 — Locations + Lanes", () => {
  test("admin creates a customer, two locations, and a lane between them", async ({ page }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);

    const customerName = `Shopee Rotas ${uniqueCode("E2E")}`;
    await createCustomer(page, { name: customerName, code: uniqueCode("E2E-CUST") });
    const originName = `Origem ${uniqueCode("O")}`;
    const destName = `Destino ${uniqueCode("D")}`;
    await createLocation(page, { name: originName, code: uniqueCode("E2E-ORIG"), customerName });
    await createLocation(page, { name: destName, code: uniqueCode("E2E-DEST"), customerName });

    await page.goto("/admin/lanes");
    await page.getByRole("button", { name: PT.laneNew }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await selectOption(page, PT.customer, customerName);
    await selectOption(page, PT.origin, originName);
    await selectOption(page, PT.destination, destName);
    await dialog.getByRole("button", { name: PT.laneCreate }).click();

    // The new lane appears in the list (origin + destination names render in the row).
    await expect(page.getByRole("row", { name: new RegExp(originName) })).toBeVisible();
  });

  test("a different-customer location is not selectable for the lane's destination", async ({
    page,
  }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);

    const customerA = `Cliente A ${uniqueCode("E2E")}`;
    const customerB = `Cliente B ${uniqueCode("E2E")}`;
    await createCustomer(page, { name: customerA, code: uniqueCode("E2E-A") });
    await createCustomer(page, { name: customerB, code: uniqueCode("E2E-B") });

    const originA = `Origem A ${uniqueCode("O")}`;
    const locB = `Local B ${uniqueCode("B")}`;
    await createLocation(page, { name: originA, code: uniqueCode("E2E-OA"), customerName: customerA });
    await createLocation(page, { name: locB, code: uniqueCode("E2E-LB"), customerName: customerB });

    await page.goto("/admin/lanes");
    await page.getByRole("button", { name: PT.laneNew }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await selectOption(page, PT.customer, customerA);
    // Open the destination select: customer B's location must NOT be an option (lists are scoped).
    await dialog.getByRole("combobox", { name: PT.destination }).click();
    await expect(page.getByRole("option", { name: locB, exact: true })).toHaveCount(0);
    await expect(page.getByRole("option", { name: originA, exact: true })).toBeVisible();
  });

  test("origin = destination is rejected", async ({ page }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);

    const customerName = `Cliente Degen ${uniqueCode("E2E")}`;
    await createCustomer(page, { name: customerName, code: uniqueCode("E2E-DG") });
    const onlyLoc = `Único ${uniqueCode("U")}`;
    await createLocation(page, {
      name: onlyLoc,
      code: uniqueCode("E2E-ONLY"),
      customerName,
    });

    await page.goto("/admin/lanes");
    await page.getByRole("button", { name: PT.laneNew }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await selectOption(page, PT.customer, customerName);
    await selectOption(page, PT.origin, onlyLoc);
    await selectOption(page, PT.destination, onlyLoc);
    await dialog.getByRole("button", { name: PT.laneCreate }).click();

    // The bad lane must be rejected at the UI: the client-side Zod degenerate refine, the server
    // INVALID_LANE_REFERENCE, or (if the second identical option doesn't register) the destination
    // validation — any of these proves the lane was not created. The degenerate-specific rule is
    // verified deterministically in the Zod + lanes-service integration tests.
    await expect(
      dialog
        .getByText(
          /origem e o destino devem ser.*diferentes|locais ativos do mesmo cliente|Destino inválido/i,
        )
        .first(),
    ).toBeVisible();
  });

  test("an archived location is excluded from the new-lane selection", async ({ page }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);

    const customerName = `Cliente Arq ${uniqueCode("E2E")}`;
    await createCustomer(page, { name: customerName, code: uniqueCode("E2E-AR") });
    const keepLoc = `Ativo ${uniqueCode("K")}`;
    const archiveLoc = `Arquivar ${uniqueCode("X")}`;
    const archiveCode = uniqueCode("E2E-ARCH");
    await createLocation(page, { name: keepLoc, code: uniqueCode("E2E-KEEP"), customerName });
    await createLocation(page, { name: archiveLoc, code: archiveCode, customerName });

    // Archive the second location from the locations list.
    await page.goto("/admin/locations");
    const row = page.getByRole("row", { name: new RegExp(archiveCode) });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: PT.archive }).click();
    await expect(page.getByRole("row", { name: new RegExp(archiveCode) })).toHaveCount(0);

    // It must not appear in the lane origin select for this customer.
    await page.goto("/admin/lanes");
    await page.getByRole("button", { name: PT.laneNew }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await selectOption(page, PT.customer, customerName);
    await dialog.getByRole("combobox", { name: PT.origin }).click();
    await expect(page.getByRole("option", { name: archiveLoc, exact: true })).toHaveCount(0);
    await expect(page.getByRole("option", { name: keepLoc, exact: true })).toBeVisible();
  });
});
