import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { testAccounts, routes } from "./test-config";

/**
 * US4 — audit read view (T052). Drives the four feature-001 audited mutations through the admin
 * Users API as a signed-in Admin, then asserts every one surfaces as a retrievable entry on
 * /admin/audit with all required fields. Also asserts a non-admin GET /api/admin/audit-logs → 403.
 *
 * No DB here: this spec is authored, not run. It relies on the seeded accounts in test-config and
 * the live BFF; it makes no assumptions beyond the public route contracts.
 */

/** Sign in via the login form and land in the authenticated shell. */
async function signIn(page: Page, account: { email: string; password: string }): Promise<void> {
  await page.goto(routes.login);
  await page.getByLabel(/e-?mail/i).fill(account.email);
  await page.getByLabel(/senha/i).fill(account.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  // A must_change_password admin is routed to set-password; otherwise the shell.
  await page.waitForURL((url) => !url.pathname.startsWith(routes.login), { timeout: 15_000 });
}

/** A unique email per run so re-runs never collide on the duplicate-email guard. */
function uniqueEmail(): string {
  return `e2e-audit-${Date.now()}-${Math.floor(Math.random() * 1e6)}@braziltransports.com.br`;
}

interface CreatedUser {
  user: { id: string; email: string };
}

test.describe("US4 — audit trail read view", () => {
  test("each of the four audited admin actions produces a retrievable audit entry", async ({
    page,
  }) => {
    await signIn(page, testAccounts.admin);

    const email = uniqueEmail();

    // 1) user.create (+ user.invite_sent): create a user via the invite onboarding path.
    const createRes = await page.request.post("/api/admin/users", {
      data: {
        name: "Auditoria E2E",
        email,
        role: "dispatcher",
        onboarding: { method: "invite" },
      },
    });
    expect(createRes.status()).toBe(201);
    const created = (await createRes.json()) as CreatedUser;
    const userId = created.user.id;
    expect(userId).toBeTruthy();

    // 2) user.role_change: promote the new user.
    const roleRes = await page.request.patch(`/api/admin/users/${userId}`, {
      data: { role: "fleet_coordinator" },
    });
    expect(roleRes.ok()).toBeTruthy();

    // 3) user.status_change: disable the new user (reason recorded on the audit entry).
    const statusRes = await page.request.patch(`/api/admin/users/${userId}`, {
      data: { status: "disabled", reason: "Encerramento de teste e2e" },
    });
    expect(statusRes.ok()).toBeTruthy();

    // The audit API returns every action, newest first; confirm all four are present for this user.
    // 009 — response shape is now `{ items, total }` with an `actorName` join (contracts §4).
    const logsRes = await page.request.get(
      `/api/admin/audit-logs?entityType=user&entityId=${userId}`,
    );
    expect(logsRes.ok()).toBeTruthy();
    const { items: entries, total } = (await logsRes.json()) as {
      total: number;
      items: Array<{
        id: string;
        entityType: string;
        entityId: string;
        action: string;
        actorUserId: string;
        actorName: string | null;
        createdAt: string;
        previousValue: unknown;
        newValue: unknown;
        reason: string | null;
      }>;
    };
    expect(total).toBeGreaterThanOrEqual(4);

    const actions = entries.map((e) => e.action);
    for (const expected of [
      "user.create",
      "user.invite_sent",
      "user.role_change",
      "user.status_change",
    ]) {
      expect(actions).toContain(expected);
    }

    // Every entry carries the required fields (entity, action, actor, when, prev/new shape).
    for (const entry of entries) {
      expect(entry.entityType).toBe("user");
      expect(entry.entityId).toBe(userId);
      expect(entry.actorUserId).toBeTruthy();
      expect(Number.isNaN(Date.parse(entry.createdAt))).toBe(false);
      // prev/new are either an object snapshot or null — never undefined.
      expect(entry.previousValue !== undefined).toBe(true);
      expect(entry.newValue !== undefined).toBe(true);
    }

    // The role_change entry exposes a before/after snapshot; status_change records the reason.
    const roleChange = entries.find((e) => e.action === "user.role_change");
    expect(roleChange?.newValue).toBeTruthy();
    const statusChange = entries.find((e) => e.action === "user.status_change");
    expect(statusChange?.reason).toBe("Encerramento de teste e2e");

    // 009 (US4) — the actor-name join is populated, and the new actor + date-range filters work.
    expect(entries.some((e) => e.actorName)).toBe(true);
    const actorId = entries[0]!.actorUserId;
    const filtered = await page.request.get(
      `/api/admin/audit-logs?actorUserId=${actorId}&entityType=user&from=2020-01-01`,
    );
    expect(filtered.ok()).toBeTruthy();
    const filteredBody = (await filtered.json()) as {
      items: Array<{ actorUserId: string }>;
      total: number;
    };
    expect(filteredBody.items.length).toBeGreaterThanOrEqual(1);
    expect(filteredBody.items.every((e) => e.actorUserId === actorId)).toBe(true);

    // The same entries are visible on the audit page: navigate and assert the new action labels.
    await page.goto(routes.adminAudit);
    const table = page.getByRole("table");
    await expect(table).toBeVisible();
    // pt-BR action labels from the AuditActions namespace must each render at least once.
    for (const label of [
      /usuário criado/i,
      /convite enviado/i,
      /perfil alterado/i,
      /status alterado/i,
    ]) {
      await expect(table.getByText(label).first()).toBeVisible();
    }
  });

  test("a non-admin cannot read the audit trail (403)", async ({ request }) => {
    const ctx: APIRequestContext = request;
    // Sign in as the non-admin via the API to obtain a session cookie.
    const signInRes = await ctx.post("/api/auth/sign-in", {
      data: {
        email: testAccounts.nonAdmin.email,
        password: testAccounts.nonAdmin.password,
      },
    });
    expect(signInRes.ok()).toBeTruthy();

    const res = await ctx.get("/api/admin/audit-logs");
    expect(res.status()).toBe(403);
  });
});
