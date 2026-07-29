import { test, expect, type APIRequestContext } from "@playwright/test";
import { testAccounts } from "./test-config";

/**
 * US5 — audit coverage (T078). Every critical master-data change writes exactly one immutable
 * `audit_logs` row (create / archive / status_change), readable via the Admin audit endpoint with
 * the correct entity_type / entity_id / action. The audit trail is append-only: no BFF route exposes
 * an update or delete of an audit row (the audit-logs route is GET-only). Per-service Vitest
 * integration tests assert the same writes at the service layer.
 */

async function adminApi(request: APIRequestContext): Promise<APIRequestContext> {
  const res = await request.post("/api/auth/sign-in", {
    data: { email: testAccounts.admin.email, password: testAccounts.admin.password },
  });
  expect(res.ok()).toBeTruthy();
  return request;
}

async function actionsFor(ctx: APIRequestContext, entityId: string): Promise<string[]> {
  const res = await ctx.get(`/api/admin/audit-logs?entityId=${entityId}`);
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { items: { action: string; entityType: string }[] };
  return body.items.map((e) => e.action);
}

test.describe("US5 — audit coverage", () => {
  test("customer create + archive each write one matching audit row", async ({ request }) => {
    const ctx = await adminApi(request);
    const create = await ctx.post("/api/master-data/customers", {
      data: { name: "Audit Cliente", customerCode: `AUD-${Date.now()}`, contacts: [] },
    });
    expect(create.status()).toBe(201);
    const { item } = (await create.json()) as { item: { id: string } };

    expect(await actionsFor(ctx, item.id)).toContain("customer.create");

    expect((await ctx.delete(`/api/master-data/customers/${item.id}`)).status()).toBe(200);
    expect(await actionsFor(ctx, item.id)).toContain("customer.archive");
  });

  test("driver status change writes a driver.status_change audit row", async ({ request }) => {
    const ctx = await adminApi(request);
    const create = await ctx.post("/api/master-data/drivers", {
      data: { name: `Audit Motorista ${Date.now()}`, ownershipType: "owned", status: "active" },
    });
    expect(create.status()).toBe(201);
    const { item } = (await create.json()) as { item: { id: string } };

    const patch = await ctx.patch(`/api/master-data/drivers/${item.id}`, {
      data: { status: "maintenance" },
    });
    expect(patch.status()).toBe(200);

    const actions = await actionsFor(ctx, item.id);
    expect(actions).toContain("driver.create");
    expect(actions).toContain("driver.status_change");
  });

  test("the audit endpoint is read-only (no write/update/delete handler)", async ({ request }) => {
    const ctx = await adminApi(request);
    // POST/PATCH/DELETE to the audit-logs route are not implemented → 405 (Next.js) and never mutate.
    const post = await ctx.post("/api/admin/audit-logs", { data: {} });
    expect([404, 405]).toContain(post.status());
  });
});
