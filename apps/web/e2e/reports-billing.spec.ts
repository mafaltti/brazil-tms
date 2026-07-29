import { test, expect, type APIRequestContext } from "@playwright/test";
import { testAccounts } from "./test-config";

/**
 * Feature 009 US3 — the billing-readiness report endpoint + screen (contracts §3). Holder `200` with
 * the report shape; no session `401`; the Prontidão de cobrança tab renders the phase counts. The `403`
 * path is covered by `permission-coverage.spec.ts` (all seven internal roles hold `view_all_trips`).
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

test("no session → GET /api/reports/billing-readiness is 401", async ({ request }) => {
  const res = await request.get("/api/reports/billing-readiness");
  expect(res.status()).toBe(401);
});

test("view_all_trips holder → 200 with the billing-readiness report shape", async ({ request }) => {
  await apiLogin(request, testAccounts.nonAdmin); // Finance — holds view_all_trips
  const res = await request.get("/api/reports/billing-readiness");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    period: { label: string };
    phaseCounts: { billing_pending: number; billing_ready: number; billed: number; disputed: number };
    completedMissingDocuments: number;
    pctReadyWithin24h: number | null;
    groups: unknown[];
  };
  expect(body.period?.label).toBeTruthy();
  expect(typeof body.phaseCounts?.billing_pending).toBe("number");
  expect(typeof body.completedMissingDocuments).toBe("number");
  expect(Array.isArray(body.groups)).toBe(true);
});

test("the Reports → Prontidão de cobrança tab renders phase counts", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(testAccounts.nonAdmin.email);
  await page.getByLabel(/senha/i).fill(testAccounts.nonAdmin.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });

  await page.goto("/reports");
  await page.getByRole("tab", { name: "Prontidão de cobrança" }).click();
  await expect(page.getByText("% prontas em 24h")).toBeVisible();
});
