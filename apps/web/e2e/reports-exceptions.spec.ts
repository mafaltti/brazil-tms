import { test, expect, type APIRequestContext } from "@playwright/test";
import { testAccounts } from "./test-config";

/**
 * Feature 009 US2 — the exception report endpoint + screen (contracts §2). Holder `200` with the
 * report shape; no session `401`; the Exceções tab renders. The `403` path is covered by
 * `permission-coverage.spec.ts` (all seven internal roles hold `view_all_trips`).
 */

async function apiLogin(
  request: APIRequestContext,
  account: { email: string; password: string },
): Promise<void> {
  const res = await request.post("/api/auth/sign-in", {
    data: { email: account.email, password: account.password },
  });
  expect(res.ok()).toBeTruthy();
}

test("no session → GET /api/reports/exceptions is 401", async ({ request }) => {
  const res = await request.get("/api/reports/exceptions");
  expect(res.status()).toBe(401);
});

test("view_all_trips holder → 200 with the exception report shape", async ({ request }) => {
  await apiLogin(request, testAccounts.opsManager);
  const res = await request.get("/api/reports/exceptions");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    period: { label: string };
    totals: { total: number; open: number; resolved: number };
    byCategory: unknown[];
    bySeverity: unknown[];
    groups: unknown[];
  };
  expect(body.period?.label).toBeTruthy();
  expect(typeof body.totals?.total).toBe("number");
  expect(Array.isArray(body.byCategory)).toBe(true);
  expect(Array.isArray(body.bySeverity)).toBe(true);
});

test("the Reports → Exceções tab renders the breakdown", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(testAccounts.opsManager.email);
  await page.getByLabel(/senha/i).fill(testAccounts.opsManager.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });

  await page.goto("/reports");
  await page.getByRole("tab", { name: "Exceções" }).click();
  await expect(page.getByText("Por categoria")).toBeVisible();
  await expect(page.getByText("Por severidade")).toBeVisible();
});
