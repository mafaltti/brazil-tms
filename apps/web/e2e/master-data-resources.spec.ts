import { test, expect, type Page } from "@playwright/test";
import { testAccounts, routes } from "./test-config";

/**
 * US3 — Drivers / Vehicles / Trailers master data, end-to-end (T073). Authored against the seeded
 * `admin`. Selectors lean on pt-BR UI strings (messages/pt-BR.json: Resources.*, ResourceStatus.*,
 * ExpiryState.*) and ARIA roles. Covers: owned-resource create → list; an operational-status cycle
 * reflected in the list; a past document expiry shown as "Vencido" and a near one as "A vencer";
 * archive removing a row from the active list (and the toggle bringing it back). The ownership default
 * is "Próprio" (owned), so these flows never touch the carrier picker.
 */

const PT = {
  archive: "Arquivar",
  includeArchived: "Incluir arquivados",
  expired: "Vencido",
  expiring: "A vencer",
} as const;

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto(routes.login);
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

function uniquePlate(): string {
  // 3 letters + 4 digits within the BR/Mercosul schema regex; randomized to stay unique.
  const letter = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
  const digits = String(Math.floor(1000 + Math.random() * 9000));
  return `${letter()}${letter()}${letter()}${digits}`;
}

function isoOffsetDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Pick a value in a shadcn/Radix Select identified by its trigger id. */
async function selectOption(page: Page, triggerId: string, optionLabel: string): Promise<void> {
  await page.locator(`#${triggerId}`).click();
  await page.getByRole("option", { name: optionLabel, exact: true }).click();
}

test.describe("US3 — Resources (drivers, vehicles, trailers)", () => {
  test("admin creates an owned driver that appears in the list", async ({ page }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);
    await page.goto("/resources/drivers");

    const name = `Motorista E2E ${Date.now()}`;
    await page.getByRole("button", { name: "Novo motorista" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Issue #28 [0005]: the form offers CPF and no longer offers E-mail.
    await expect(dialog.getByLabel("CPF", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("E-mail")).toHaveCount(0);

    await dialog.getByLabel("Nome", { exact: true }).fill(name);
    await dialog.getByLabel("CPF", { exact: true }).fill("390.533.447-05");
    await dialog.getByRole("button", { name: "Criar motorista" }).click();

    await expect(page.getByRole("row", { name: new RegExp(name) })).toBeVisible();

    // The punctuated CPF was normalized to 11 digits and round-trips into the edit form.
    await page
      .getByRole("row", { name: new RegExp(name) })
      .getByRole("link", { name: "Editar" })
      .click();
    await page.waitForURL((url) => url.pathname.startsWith("/resources/drivers/"));
    await expect(page.getByLabel("CPF", { exact: true })).toHaveValue("39053344705");
  });

  test("admin creates an owned vehicle; a past document expiry shows 'Vencido'", async ({
    page,
  }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);
    await page.goto("/resources/vehicles");

    const plate = uniquePlate();
    await page.getByRole("button", { name: "Novo veículo" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Placa", { exact: true }).fill(plate);
    await selectOption(page, "vehicleType", "Truck");

    // Issue #30 [0007]: the registry identifiers are captured and normalized (Renavam strips
    // punctuation; chassi uppercases) — verified on the edit round-trip below.
    await dialog.getByLabel("Renavam", { exact: true }).fill("1234.567.890-1");
    await dialog.getByLabel("ANTT", { exact: true }).fill("12345678");
    await dialog.getByLabel("Chassi", { exact: true }).fill("9bwzzz377vt004251");

    await dialog.getByLabel("Validade do documento").fill(isoOffsetDays(-1));
    await dialog.getByRole("button", { name: "Criar veículo" }).click();

    const row = page.getByRole("row", { name: new RegExp(plate) });
    await expect(row).toBeVisible();
    await expect(row.getByText(PT.expired)).toBeVisible();

    await row.getByRole("link", { name: "Editar" }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/resources/vehicles/"));
    await expect(page.getByLabel("Renavam", { exact: true })).toHaveValue("12345678901");
    await expect(page.getByLabel("ANTT", { exact: true })).toHaveValue("12345678");
    await expect(page.getByLabel("Chassi", { exact: true })).toHaveValue("9BWZZZ377VT004251");
  });

  test("a vehicle with a near expiry shows 'A vencer'", async ({ page }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);
    await page.goto("/resources/vehicles");

    const plate = uniquePlate();
    await page.getByRole("button", { name: "Novo veículo" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Placa", { exact: true }).fill(plate);
    await selectOption(page, "vehicleType", "Van");
    await dialog.getByLabel("Validade do documento").fill(isoOffsetDays(15));
    await dialog.getByRole("button", { name: "Criar veículo" }).click();

    const row = page.getByRole("row", { name: new RegExp(plate) });
    await expect(row).toBeVisible();
    await expect(row.getByText(PT.expiring)).toBeVisible();
  });

  test("admin creates an owned trailer that appears in the list", async ({ page }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);
    await page.goto("/resources/trailers");

    const plate = uniquePlate();
    await page.getByRole("button", { name: "Novo reboque" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Placa", { exact: true }).fill(plate);
    await selectOption(page, "trailerType", "Sider");
    await dialog.getByRole("button", { name: "Criar reboque" }).click();

    await expect(page.getByRole("row", { name: new RegExp(plate) })).toBeVisible();
  });

  test("an operational status change is reflected in the drivers list", async ({ page }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);
    await page.goto("/resources/drivers");

    const name = `Status E2E ${Date.now()}`;
    await page.getByRole("button", { name: "Novo motorista" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Nome", { exact: true }).fill(name);
    await dialog.getByRole("button", { name: "Criar motorista" }).click();

    const row = page.getByRole("row", { name: new RegExp(name) });
    await expect(row).toBeVisible();
    // The row shows "Ativo" twice (operational status + active/archived situação); assert presence,
    // not a single match.
    await expect(row.getByText("Ativo").first()).toBeVisible();

    // Edit → change operational status → save; the list reflects the new status.
    await row.getByRole("link", { name: "Editar" }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/resources/drivers/"));
    await selectOption(page, "status", "Manutenção");
    await page.getByRole("button", { name: "Salvar" }).click();

    await page.waitForURL((url) => url.pathname === "/resources/drivers");
    const updatedRow = page.getByRole("row", { name: new RegExp(name) });
    await expect(updatedRow.getByText("Manutenção")).toBeVisible();
  });

  test("admin archives a driver; it leaves the active list and returns with the toggle", async ({
    page,
  }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);
    await page.goto("/resources/drivers");

    const name = `Arquivar E2E ${Date.now()}`;
    await page.getByRole("button", { name: "Novo motorista" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Nome", { exact: true }).fill(name);
    await dialog.getByRole("button", { name: "Criar motorista" }).click();

    const row = page.getByRole("row", { name: new RegExp(name) });
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: PT.archive }).click();
    await expect(page.getByRole("row", { name: new RegExp(name) })).toHaveCount(0);

    await page.getByLabel(PT.includeArchived).check();
    await expect(page.getByRole("row", { name: new RegExp(name) })).toBeVisible();
  });
});
