import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { and, eq, inArray } from "drizzle-orm";
import {
  alerts,
  auditLogs,
  cancellationOptions,
  customers,
  db,
  exceptions,
  locations,
  tripEvents,
  trips,
} from "@brazil-tms/db";
import { routes, testAccounts } from "./test-config";

/**
 * Feature 017 (issue #24) — trip cancellation on the three surfaces: Trip Detail (US1), the Dispatch
 * board row (US2), and the Control Tower table row (US3), plus the FR-008 loophole close and the §18
 * permission boundaries (Dispatcher "Limited" = dispatch phase; Finance/Fleet Coordinator: none).
 *
 * Self-seeds via `@brazil-tms/db` (its own customer/locations/trips AND its own ACTIVE
 * `cancellation_options` rows with unique labels, so the dialog flows don't depend on the default
 * seed); FK-safe cleanup. Requires the app + DB (the standard e2e harness).
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

async function login(page: Page, account: { email: string; password: string }): Promise<void> {
  await page.goto(routes.login);
  await page.getByLabel(/e-?mail/i).fill(account.email);
  await page.getByLabel(/senha/i).fill(account.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith(routes.login), { timeout: 15_000 });
}

let customerId = "";
let originId = "";
let destId = "";
let reasonLabel = "";
let billingLabel = "";
// The suite's REAL option codes — refusal tests must use them so they hit the status/role guards,
// not INVALID_REASON_CODE (option validation runs first in the service).
let reasonCodeValue = "";
let billingCodeValue = "";
const tripIds: string[] = [];
const optionIds: string[] = [];

async function seedTrip(currentStatus = "received"): Promise<{ id: string; externalId: string }> {
  const externalId = code("EXT-CXL");
  const inserted = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId: externalId,
      originLocationId: originId,
      destinationLocationId: destId,
      currentStatus: currentStatus as never,
      originalPlan: {},
    })
    .returning({ id: trips.id });
  const id = inserted[0]!.id;
  tripIds.push(id);
  return { id, externalId };
}

/** Complete the shared CancelTripDialog: motivo + parte responsável + impacto, then confirm. */
async function fillCancelDialog(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Motivo").click();
  await page.getByRole("option", { name: reasonLabel }).click();
  await dialog.getByLabel("Parte responsável").click();
  await page.getByRole("option", { name: "Transportadora" }).click();
  await dialog.getByLabel("Impacto de faturamento").click();
  await page.getByRole("option", { name: billingLabel }).click();
  await dialog.getByRole("button", { name: "Cancelar viagem" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

test.beforeAll(async () => {
  const cust = await db
    .insert(customers)
    .values({ name: "Cliente Cancelamento 017", customerCode: code("CUST-CXL") })
    .returning({ id: customers.id });
  customerId = cust[0]!.id;
  const origin = await db
    .insert(locations)
    .values({ customerId, code: code("ORIG"), name: "Origem Cancel" })
    .returning({ id: locations.id });
  originId = origin[0]!.id;
  const dest = await db
    .insert(locations)
    .values({ customerId, code: code("DEST"), name: "Destino Cancel" })
    .returning({ id: locations.id });
  destId = dest[0]!.id;

  // The suite's OWN active option rows — unique labels so the dialog selections are unambiguous.
  const suffix = code("E2E");
  reasonLabel = `Motivo ${suffix}`;
  billingLabel = `Impacto ${suffix}`;
  reasonCodeValue = code("reason");
  billingCodeValue = code("billing");
  const reason = await db
    .insert(cancellationOptions)
    .values({ kind: "reason", code: reasonCodeValue, labelPt: reasonLabel, active: true })
    .returning({ id: cancellationOptions.id });
  optionIds.push(reason[0]!.id);
  const billing = await db
    .insert(cancellationOptions)
    .values({ kind: "billing_impact", code: billingCodeValue, labelPt: billingLabel, active: true })
    .returning({ id: cancellationOptions.id });
  optionIds.push(billing[0]!.id);
});

test.afterAll(async () => {
  if (tripIds.length) {
    await db.delete(alerts).where(inArray(alerts.tripId, tripIds));
    await db.delete(exceptions).where(inArray(exceptions.tripId, tripIds));
    await db.delete(tripEvents).where(inArray(tripEvents.tripId, tripIds));
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, tripIds));
    await db.delete(trips).where(inArray(trips.id, tripIds));
  }
  if (optionIds.length) {
    await db.delete(cancellationOptions).where(inArray(cancellationOptions.id, optionIds));
  }
  for (const id of [originId, destId]) {
    if (id) await db.delete(locations).where(eq(locations.id, id));
  }
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

test.describe("US1 — cancel from Trip Detail", () => {
  test("Ops Manager cancels a received trip with full justification; badge, timeline and audit reflect it", async ({
    page,
  }) => {
    const { id } = await seedTrip("received");
    await login(page, testAccounts.opsManager);
    await page.goto(`/trips/${id}`);

    await page.getByRole("button", { name: "Cancelar viagem" }).click();
    await fillCancelDialog(page);

    // Badge flips to the terminal label; the audit section lists the cancel action.
    await expect(page.getByText("Cancelada").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Viagem cancelada").first()).toBeVisible();

    // Domain truth: status, §19.5 fields, audit row, status_change event.
    const row = (await db.select().from(trips).where(eq(trips.id, id)).limit(1))[0]!;
    expect(row.currentStatus).toBe("cancelled");
    expect(row.cancellationReasonCode).toBeTruthy();
    expect(row.cancellationResponsibleParty).toBe("carrier_caused");
    expect(row.cancellationBillingImpact).toBeTruthy();
    expect(row.cancelledAt).not.toBeNull();
    const audit = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "trip.cancel")));
    expect(audit).toHaveLength(1);
  });

  test("a submission missing a required element is rejected inline; the trip is unchanged (FR-006)", async ({
    page,
  }) => {
    const { id } = await seedTrip("received");
    await login(page, testAccounts.opsManager);
    await page.goto(`/trips/${id}`);

    await page.getByRole("button", { name: "Cancelar viagem" }).click();
    const dialog = page.getByRole("dialog");
    // Fill ONLY the motivo, then submit.
    await dialog.getByLabel("Motivo").click();
    await page.getByRole("option", { name: reasonLabel }).click();
    await dialog.getByRole("button", { name: "Cancelar viagem" }).click();

    await expect(dialog.getByText("Campo obrigatório.").first()).toBeVisible();
    const row = (await db.select({ s: trips.currentStatus }).from(trips).where(eq(trips.id, id)))[0]!;
    expect(row.s).toBe("received");
  });

  test("Finance (view-only) sees no cancel action and a direct POST is 403 (§18)", async ({
    page,
    request,
  }) => {
    const { id } = await seedTrip("received");
    await login(page, testAccounts.nonAdmin);
    await page.goto(`/trips/${id}`);
    await expect(page.getByText("Cancelada", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cancelar viagem" })).toHaveCount(0);

    await apiLogin(request, testAccounts.nonAdmin);
    const res = await request.post(`/api/trips/${id}/cancel`, {
      data: { reasonCode: "x", responsibleParty: "unknown", billingImpact: "y" },
    });
    expect(res.status()).toBe(403);
  });

  test("Dispatcher 'Limited': no action on an in_transit trip; direct POST → 409 NOT_CANCELLABLE_BY_ROLE; Ops Manager then cancels it", async ({
    page,
    request,
  }) => {
    const { id } = await seedTrip("in_transit");
    await login(page, testAccounts.dispatcher);
    await page.goto(`/trips/${id}`);
    await expect(page.getByRole("button", { name: "Cancelar viagem" })).toHaveCount(0);

    await apiLogin(request, testAccounts.dispatcher);
    const denied = await request.post(`/api/trips/${id}/cancel`, {
      data: {
        reasonCode: reasonCodeValue,
        responsibleParty: "unknown",
        billingImpact: billingCodeValue,
      },
    });
    expect(denied.status()).toBe(409);
    expect((await denied.json()).error.code).toBe("NOT_CANCELLABLE_BY_ROLE");

    // Unrestricted holder (Ops Manager) cancels the same trip.
    await apiLogin(request, testAccounts.opsManager);
    const ok = await request.post(`/api/trips/${id}/cancel`, {
      data: {
        reasonCode: reasonCodeValue,
        responsibleParty: "carrier_caused",
        billingImpact: billingCodeValue,
      },
    });
    expect(ok.status()).toBe(200);
  });

  test("the generic /status route refuses toStatus=cancelled (FR-008 — USE_CANCELLATION_ENDPOINT)", async ({
    request,
  }) => {
    const { id } = await seedTrip("confirmed");
    await apiLogin(request, testAccounts.dispatcher);
    const res = await request.post(`/api/trips/${id}/status`, {
      data: { expectedFromStatus: "confirmed", toStatus: "cancelled" },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).error.code).toBe("USE_CANCELLATION_ENDPOINT");
    const row = (await db.select({ s: trips.currentStatus }).from(trips).where(eq(trips.id, id)))[0]!;
    expect(row.s).toBe("confirmed");
  });

  test("a completed trip offers no cancel action and a direct POST is 409 NOT_CANCELLABLE", async ({
    page,
    request,
  }) => {
    const { id } = await seedTrip("completed");
    await login(page, testAccounts.opsManager);
    await page.goto(`/trips/${id}`);
    await expect(page.getByRole("button", { name: "Cancelar viagem" })).toHaveCount(0);

    await apiLogin(request, testAccounts.opsManager);
    const res = await request.post(`/api/trips/${id}/cancel`, {
      data: {
        reasonCode: reasonCodeValue,
        responsibleParty: "unknown",
        billingImpact: billingCodeValue,
      },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).error.code).toBe("NOT_CANCELLABLE");
  });
});

test.describe("US2 — cancel from the Dispatch board row", () => {
  test("Dispatcher cancels a queued trip from its row; the row leaves the queue", async ({ page }) => {
    const { externalId } = await seedTrip("received");
    await login(page, testAccounts.dispatcher);
    await page.goto("/dispatch");

    const row = page.locator("li", { hasText: externalId });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole("button", { name: "Cancelar viagem" }).click();
    await fillCancelDialog(page);

    // The ["trips"] invalidation refetches the queue — the cancelled trip leaves it.
    await expect(page.getByText(externalId)).toBeHidden({ timeout: 15_000 });
  });

  test("Fleet Coordinator (assign_resources, no cancel_trip) sees Atribuir but no cancel action", async ({
    page,
  }) => {
    const { externalId } = await seedTrip("received");
    await login(page, testAccounts.fleetCoord);
    await page.goto("/dispatch");

    const row = page.locator("li", { hasText: externalId });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByRole("button", { name: "Atribuir" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Cancelar viagem" })).toHaveCount(0);
  });
});

test.describe("US3 — cancel from the Control Tower table row", () => {
  test("Admin cancels from a list row; the row leaves the default active view", async ({ page }) => {
    const { externalId } = await seedTrip("received");
    await login(page, testAccounts.admin);
    await page.goto("/trips");

    const row = page.getByRole("row", { name: new RegExp(externalId) });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole("button", { name: "Cancelar viagem" }).click();
    await fillCancelDialog(page);

    // The default board scope is active/open trips — a cancelled trip drops out on refetch.
    await expect(page.getByRole("row", { name: new RegExp(externalId) })).toBeHidden({
      timeout: 15_000,
    });
  });

  test("Finance sees no per-row cancel action on the board", async ({ page }) => {
    const { externalId } = await seedTrip("received");
    await login(page, testAccounts.nonAdmin);
    await page.goto("/trips");

    const row = page.getByRole("row", { name: new RegExp(externalId) });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByRole("button", { name: "Cancelar viagem" })).toHaveCount(0);
  });
});
