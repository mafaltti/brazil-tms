import { test, expect, type APIRequestContext } from "@playwright/test";
import { testAccounts } from "./test-config";

/**
 * US5 — archive is non-destructive (T077). For one entity per domain (a commercial customer and a
 * fleet driver), archiving via DELETE hides it from the active list, keeps it retrievable with
 * `?includeArchived=true`, and never hard-deletes (the detail endpoint still returns the record).
 * Driven through the BFF as the seeded Admin (the only role that may archive).
 */

async function adminApi(request: APIRequestContext): Promise<APIRequestContext> {
  const res = await request.post("/api/auth/sign-in", {
    data: { email: testAccounts.admin.email, password: testAccounts.admin.password },
  });
  expect(res.ok()).toBeTruthy();
  return request;
}

async function created<T extends { id: string }>(res: { json(): Promise<unknown> }): Promise<T> {
  const body = (await res.json()) as { item: T };
  return body.item;
}

test.describe("US5 — archive-not-delete", () => {
  test("customer: archived row leaves the active list, stays retrievable, is never hard-deleted", async ({
    request,
  }) => {
    const ctx = await adminApi(request);
    const code = `ARCH-${Date.now()}`;
    const create = await ctx.post("/api/master-data/customers", {
      data: { name: "Arquivo Cliente", customerCode: code, contacts: [] },
    });
    expect(create.status()).toBe(201);
    const item = await created<{ id: string; archived: boolean }>(create);

    const del = await ctx.delete(`/api/master-data/customers/${item.id}`);
    expect(del.status()).toBe(200);

    const active = await (await ctx.get("/api/master-data/customers")).json();
    expect((active as { items: { id: string }[] }).items.find((c) => c.id === item.id)).toBeUndefined();

    const all = await (await ctx.get("/api/master-data/customers?includeArchived=true")).json();
    const found = (all as { items: { id: string; archived: boolean }[] }).items.find(
      (c) => c.id === item.id,
    );
    expect(found?.archived).toBe(true);

    // Detail endpoint still returns it — the record was archived, not deleted.
    const detail = await ctx.get(`/api/master-data/customers/${item.id}`);
    expect(detail.status()).toBe(200);
  });

  test("driver: archive hides from active list but record persists", async ({ request }) => {
    const ctx = await adminApi(request);
    const create = await ctx.post("/api/master-data/drivers", {
      data: { name: `Motorista Arquivo ${Date.now()}`, ownershipType: "owned" },
    });
    expect(create.status()).toBe(201);
    const item = await created<{ id: string }>(create);

    expect((await ctx.delete(`/api/master-data/drivers/${item.id}`)).status()).toBe(200);

    const active = await (await ctx.get("/api/master-data/drivers")).json();
    expect((active as { items: { id: string }[] }).items.find((d) => d.id === item.id)).toBeUndefined();

    const detail = await ctx.get(`/api/master-data/drivers/${item.id}`);
    expect(detail.status()).toBe(200);
  });
});
