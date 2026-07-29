import { test, expect, type Page } from "@playwright/test";
import { testAccounts, routes } from "./test-config";

/**
 * Slice 025 (issue #32 [0009]) — the "Documentos" tab on the driver/vehicle EDIT pages: append-only
 * upload history (newest first), signed-URL open, and the reject paths. Runs against the local
 * no-Docker harness — the mock server implements the Storage subset (in-memory), so the full
 * upload → history → download flow is exercised end-to-end.
 */

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto(routes.login);
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

/** Create a resource via the list dialog and land on its edit page. */
async function createAndOpen(page: Page, opts: { path: string; newButton: string; name?: string; plate?: string; createButton: string }): Promise<void> {
  await page.goto(opts.path);
  await page.getByRole("button", { name: opts.newButton }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  if (opts.name) await dialog.getByLabel("Nome", { exact: true }).fill(opts.name);
  if (opts.plate) {
    await dialog.getByLabel("Placa", { exact: true }).fill(opts.plate);
    await dialog.locator("#vehicleType").click();
    await page.getByRole("option", { name: "Truck", exact: true }).click();
  }
  await dialog.getByRole("button", { name: opts.createButton }).click();
  const row = page.getByRole("row", { name: new RegExp(opts.name ?? opts.plate ?? "") });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "Editar" }).click();
  await page.waitForURL((url) => /\/resources\/(drivers|vehicles)\//.test(url.pathname));
}

function uniquePlate(): string {
  const letter = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `${letter()}${letter()}${letter()}${1000 + Math.floor(Math.random() * 9000)}`;
}

const PDF = { name: "cnh-digital.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 fake") };
const PNG = { name: "photocheck.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
const TXT = { name: "nota.txt", mimeType: "text/plain", buffer: Buffer.from("nope") };

test.describe("Documentos tab (issue #32)", () => {
  test("driver: upload builds an append-only history, newest first, and opens via signed URL", async ({
    page,
    context,
  }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);
    await createAndOpen(page, {
      path: "/resources/drivers",
      newButton: "Novo motorista",
      name: `Docs E2E ${Date.now()}`,
      createButton: "Criar motorista",
    });

    // The edit page offers the two tabs; create mode (checked implicitly) had none.
    await expect(page.getByRole("tab", { name: "Dados gerais" })).toBeVisible();
    await page.getByRole("tab", { name: "Documentos" }).click();
    await expect(page.getByText("Nenhum documento enviado ainda.")).toBeVisible();

    // First upload — CNH digital (pdf).
    await page.getByLabel("Tipo do documento").fill("CNH digital");
    await page.getByLabel("Arquivo").setInputFiles(PDF);
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Documento enviado." })).toBeVisible();
    await expect(page.getByText("CNH digital", { exact: true })).toBeVisible();
    await expect(page.getByText("cnh-digital.pdf")).toBeVisible();

    // Second upload — Photocheck (png): BOTH entries remain (append-only), newest first.
    await page.getByLabel("Tipo do documento").fill("Photocheck");
    await page.getByLabel("Arquivo").setInputFiles(PNG);
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(page.getByText("Photocheck", { exact: true })).toBeVisible();
    const entries = page.locator("ul > li");
    await expect(entries).toHaveCount(2);
    await expect(entries.first()).toContainText("Photocheck");
    await expect(entries.last()).toContainText("CNH digital");

    // Each entry is a plain <a target="_blank"> into the 302 download route (user activation
    // survives — no popup blocking); the new tab lands on the signed Storage URL.
    const popupPromise = context.waitForEvent("page");
    await entries.first().getByRole("link").click();
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    expect(popup.url()).toContain("/storage/v1/object/sign/");
    await popup.close();

    // Reject path: a .txt is refused client-independently by the server (nothing stored).
    await page.getByLabel("Tipo do documento").fill("Nota");
    await page.getByLabel("Arquivo").setInputFiles(TXT);
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Tipo de arquivo não suportado" }),
    ).toBeVisible();
    await expect(entries).toHaveCount(2);
  });

  test("vehicle: the Documentos tab exists and uploads land in the history", async ({ page }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);
    await createAndOpen(page, {
      path: "/resources/vehicles",
      newButton: "Novo veículo",
      plate: uniquePlate(),
      createButton: "Criar veículo",
    });

    await page.getByRole("tab", { name: "Documentos" }).click();
    await page.getByLabel("Tipo do documento").fill("CRLV digital");
    await page.getByLabel("Arquivo").setInputFiles(PDF);
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(page.getByText("CRLV digital", { exact: true })).toBeVisible();
  });
});
