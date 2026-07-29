import { test, expect, type APIRequestContext } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";
import { auditLogs, customers, customerSlaRules, db, locations } from "@brazil-tms/db";
import { testAccounts } from "./test-config";

/**
 * Feature 007 US5 — per-customer SLA-rule admin e2e (HTTP-level). Creates + edits a rule as an Ops
 * Manager (`manage_commercial_data`), confirms it appears in the list, asserts a non-holder (Finance)
 * is 403 on create/update, and that the audit shows sla_rule.create/update. Self-seeds a customer;
 * FK-safe cleanup; requires the app + DB.
 */

function code(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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

let customerId = "";
let originId = "";
let destId = "";
const ruleIds: string[] = [];

test.beforeAll(async () => {
  const cust = await db.insert(customers).values({ name: "Cliente SLARule E2E", customerCode: code("CUST") }).returning({ id: customers.id });
  customerId = cust[0]!.id;
  const origin = await db.insert(locations).values({ customerId, code: code("ORIG"), name: "Origem" }).returning({ id: locations.id });
  originId = origin[0]!.id;
  const dest = await db.insert(locations).values({ customerId, code: code("DEST"), name: "Destino" }).returning({ id: locations.id });
  destId = dest[0]!.id;
});

test.afterAll(async () => {
  if (ruleIds.length) {
    for (const id of ruleIds) await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
  }
  await db.delete(customerSlaRules).where(eq(customerSlaRules.customerId, customerId));
  await db.delete(locations).where(inArray(locations.id, [originId, destId]));
  await db.delete(customers).where(eq(customers.id, customerId));
});

test.describe("007 US5 — per-customer SLA rules", () => {
  test("Ops Manager creates + edits a rule; it appears in the list; audit shows create/update", async ({
    request,
  }) => {
    await apiLogin(request, testAccounts.opsManager);

    const create = await request.post(`/api/customer-sla-rules`, {
      data: {
        customerId,
        pickupToleranceMinutes: 15,
        deliveryToleranceMinutes: 30,
        confirmationCutoffMinutes: 90,
        atRiskWarningMinutes: 60,
      },
    });
    expect(create.status()).toBe(201);
    const { item } = (await create.json()) as { item: { id: string } };
    ruleIds.push(item.id);

    const patch = await request.patch(`/api/customer-sla-rules/${item.id}`, {
      data: { atRiskWarningMinutes: 45 },
    });
    expect(patch.ok()).toBeTruthy();

    const list = await request.get(`/api/customer-sla-rules`);
    const { items } = (await list.json()) as {
      items: Array<{ id: string; customerId: string; atRiskWarningMinutes: number }>;
    };
    const mine = items.find((r) => r.id === item.id)!;
    expect(mine).toBeTruthy();
    expect(mine.customerId).toBe(customerId);
    expect(mine.atRiskWarningMinutes).toBe(45);

    // Audit rows (sla_rule.create + sla_rule.update) on the rule entity.
    const audit = await db.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, item.id));
    const actions = audit.map((a) => a.action);
    expect(actions).toContain("sla_rule.create");
    expect(actions).toContain("sla_rule.update");
  });

  test("a non-holder (Finance) is 403 on create + update; the list is readable via view_all_trips", async ({
    request,
  }) => {
    // Seed a rule as Ops Manager to target with the update-403.
    await apiLogin(request, testAccounts.opsManager);
    const create = await request.post(`/api/customer-sla-rules`, {
      data: {
        customerId,
        pickupToleranceMinutes: 0,
        deliveryToleranceMinutes: 0,
        confirmationCutoffMinutes: 120,
        atRiskWarningMinutes: 60,
      },
    });
    expect(create.status()).toBe(201);
    const { item } = (await create.json()) as { item: { id: string } };
    ruleIds.push(item.id);

    // Finance: 403 on the writes.
    await apiLogin(request, testAccounts.nonAdmin);
    const create403 = await request.post(`/api/customer-sla-rules`, {
      data: {
        customerId,
        pickupToleranceMinutes: 0,
        deliveryToleranceMinutes: 0,
        confirmationCutoffMinutes: 120,
        atRiskWarningMinutes: 60,
      },
    });
    expect(create403.status()).toBe(403);
    const patch403 = await request.patch(`/api/customer-sla-rules/${item.id}`, {
      data: { atRiskWarningMinutes: 99 },
    });
    expect(patch403.status()).toBe(403);

    // ...but Finance CAN read the list (view_all_trips).
    const list = await request.get(`/api/customer-sla-rules`);
    expect(list.status()).toBe(200);
  });
});
