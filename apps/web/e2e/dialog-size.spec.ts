import { test, expect, type Page } from "@playwright/test";
import { testAccounts, routes } from "./test-config";

/**
 * Slice 024 (issue #31 [0008]) — the driver/vehicle/trailer CREATE dialogs render substantially
 * larger than the base max-w-lg (512px): max-w-4xl (896px, with a viewport gutter below that)
 * capped at 90vh. Asserted by measuring the dialog's bounding box at the default desktop viewport
 * (1280px wide). Functional coverage of the create flows inside the wider dialogs lives in
 * master-data-resources.spec.ts. Other master-data dialogs intentionally keep the base width.
 * The 800px floor sits safely below the zoom-in-95 enter animation's first frame (896×0.95≈851),
 * so an early boundingBox() read cannot flake the assertion.
 */

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto(routes.login);
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

/** Open a create dialog and return its measured width. */
async function measureDialog(page: Page, path: string, button: string): Promise<number> {
  await page.goto(path);
  await page.getByRole("button", { name: button }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box, "dialog must have a bounding box").not.toBeNull();
  return box?.width ?? 0;
}

const CASES = [
  { path: "/resources/drivers", button: "Novo motorista" },
  { path: "/resources/vehicles", button: "Novo veículo" },
  { path: "/resources/trailers", button: "Novo reboque" },
] as const;

test.describe("Resource registration dialogs are larger (issue #31)", () => {
  for (const { path, button } of CASES) {
    test(`the "${button}" dialog measures ~896px (was 512px)`, async ({ page }) => {
      await login(page, testAccounts.admin.email, testAccounts.admin.password);
      const width = await measureDialog(page, path, button);
      // max-w-4xl = 896px; anything ≥ 800 proves the base max-w-lg (512px) was overridden
      // (and stays below the enter animation's 851px first frame — no flake window).
      expect(width).toBeGreaterThanOrEqual(800);
      expect(width).toBeLessThanOrEqual(920);
    });
  }

  test("an untargeted master-data dialog keeps the base width (customers)", async ({ page }) => {
    await login(page, testAccounts.admin.email, testAccounts.admin.password);
    const width = await measureDialog(page, "/admin/customers", "Novo cliente");
    expect(width).toBeLessThanOrEqual(520); // base max-w-lg = 512px
  });
});
