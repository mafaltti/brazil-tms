import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { testAccounts, routes } from "./test-config";

/**
 * Feature 021 (issue #29) — AI document reading. The local/CI stack has NO provider key by design,
 * so this spec covers everything except the live extraction (a manual quickstart step with a real
 * key): the affordance on the three forms, the graceful not-configured path (form untouched), and
 * the permission gate (manage_fleet_data).
 */

async function login(page: Page, account: { email: string; password: string }): Promise<void> {
  await page.goto(routes.login);
  await page.getByLabel(/e-?mail/i).fill(account.email);
  await page.getByLabel(/senha/i).fill(account.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith(routes.login), { timeout: 15_000 });
}

async function apiLogin(
  request: APIRequestContext,
  account: { email: string; password: string },
): Promise<void> {
  const res = await request.post("/api/auth/sign-in", {
    data: { email: account.email, password: account.password },
  });
  expect(res.ok()).toBeTruthy();
}

/** A 1×1 transparent PNG — enough to exercise the upload path. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test("driver form offers the CNH read; without a key it degrades gracefully and touches nothing (FR-001/FR-007)", async ({
  page,
}) => {
  await login(page, testAccounts.fleetCoord);
  await page.goto("/resources/drivers");
  await page.getByRole("button", { name: "Novo motorista" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await expect(dialog.getByRole("button", { name: "Ler CNH (IA)" })).toBeVisible();

  // Upload a file — the local stack has no ANTHROPIC_API_KEY, so the 503 dark path must surface.
  await dialog
    .locator('input[type="file"]')
    .setInputFiles({ name: "cnh.png", mimeType: "image/png", buffer: TINY_PNG });
  await expect(
    dialog.getByText("Leitura de documentos não configurada", { exact: false }),
  ).toBeVisible({ timeout: 15_000 });

  // The form was NOT touched by the failed read.
  await expect(dialog.getByLabel("Nome", { exact: true })).toHaveValue("");
});

test("vehicle and trailer forms offer the CRLV read (FR-002)", async ({ page }) => {
  await login(page, testAccounts.fleetCoord);

  await page.goto("/resources/vehicles");
  await page.getByRole("button", { name: "Novo veículo" }).click();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Ler CRLV (IA)" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto("/resources/trailers");
  await page.getByRole("button", { name: "Novo reboque" }).click();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Ler CRLV (IA)" }),
  ).toBeVisible();
});

test("the extraction endpoint enforces manage_fleet_data and validates input (FR-006)", async ({
  request,
}) => {
  // Non-holder (dispatcher) → 403 before anything else.
  await apiLogin(request, testAccounts.dispatcher);
  const denied = await request.post("/api/master-data/extract-document", {
    data: { docType: "cnh", mediaType: "image/png", data: "aGk=" },
  });
  expect(denied.status()).toBe(403);

  await apiLogin(request, testAccounts.fleetCoord);
  // Invalid body → 400 (validation precedes any provider call).
  const bad = await request.post("/api/master-data/extract-document", {
    data: { docType: "rg", mediaType: "image/png", data: "aGk=" },
  });
  expect(bad.status()).toBe(400);

  // Valid body without a server key → 503 EXTRACTION_NOT_CONFIGURED (feature dark).
  const dark = await request.post("/api/master-data/extract-document", {
    data: { docType: "cnh", mediaType: "image/png", data: "aGk=" },
  });
  expect(dark.status()).toBe(503);
  expect((await dark.json()).error.code).toBe("EXTRACTION_NOT_CONFIGURED");
});
