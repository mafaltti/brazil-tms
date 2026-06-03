import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { and, eq, inArray } from "drizzle-orm";
import { auditLogs, customers, db, locations, tripEvents, trips } from "@brazil-tms/db";
import type { TripStatus } from "@brazil-tms/shared";
import { testAccounts, routes } from "./test-config";

/**
 * 010 (GitHub #11) — the received→validated Validate action on Trip Detail. Closes the gap where an
 * imported/created trip (always `received`) had NO UI path to `validated` and so could never be
 * assigned. The action reuses `POST /api/trips/:id/status` (gated `update_trip_status`). Asserts:
 *  - an `update_trip_status` holder (Ops Manager) validates a `received` trip → `validated`, writing
 *    exactly one append-only `status_change` event (source `operator_manual`, attributable actor) and
 *    one `trip.status_change` audit row (FR-004/FR-005, SC-004);
 *  - a non-holder (Finance) is refused `403` AND the Validar button is not rendered (SC-003);
 *  - the Validar button shows on a `received` trip and NOT on a `validated` trip (status-scoped);
 *  - the `validation_error → received` correction works (FR-002).
 *
 * Self-seeds via `@brazil-tms/db` (a Playwright spec cannot import the `server-only` services); FK-safe
 * cleanup; unique ids. Requires DATABASE_URL. (db:seed:e2e seeds accounts only — trips are self-seeded.)
 */

function code(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function apiLogin(
  request: APIRequestContext,
  account: { email: string; password: string },
): Promise<APIRequestContext> {
  const res = await request.post("/api/auth/sign-in", {
    data: { email: account.email, password: account.password },
  });
  expect(res.ok(), "sign-in must succeed").toBeTruthy();
  return request;
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
const tripIds: string[] = [];

async function seedTrip(status: TripStatus): Promise<string> {
  const inserted = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId: code("EXT-VAL"),
      originLocationId: originId,
      destinationLocationId: destId,
      currentStatus: status,
      originalPlan: { customerId, originLocationId: originId, destinationLocationId: destId },
      plannedVehicleType: "truck",
    })
    .returning({ id: trips.id });
  const id = inserted[0]!.id;
  tripIds.push(id);
  return id;
}

test.beforeAll(async () => {
  const cust = await db
    .insert(customers)
    .values({ name: "Cliente Validate 010", customerCode: code("CUST") })
    .returning({ id: customers.id });
  customerId = cust[0]!.id;
  const origin = await db
    .insert(locations)
    .values({ customerId, code: code("ORIG"), name: "Origem Validate" })
    .returning({ id: locations.id });
  originId = origin[0]!.id;
  const dest = await db
    .insert(locations)
    .values({ customerId, code: code("DEST"), name: "Destino Validate" })
    .returning({ id: locations.id });
  destId = dest[0]!.id;
});

test.afterAll(async () => {
  if (tripIds.length) {
    await db.delete(tripEvents).where(inArray(tripEvents.tripId, tripIds));
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, tripIds));
    await db.delete(trips).where(inArray(trips.id, tripIds));
  }
  for (const id of [originId, destId]) if (id) await db.delete(locations).where(eq(locations.id, id));
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

test.describe("010 — Validate a received trip (#11)", () => {
  test("Ops Manager validates received → validated with one status_change event (operator_manual) + audit", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const tripId = await seedTrip("received");

    const res = await ctx.post(`/api/trips/${tripId}/status`, {
      data: { expectedFromStatus: "received", toStatus: "validated", source: "operator_manual" },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { item: { currentStatus: string } };
    expect(body.item.currentStatus).toBe("validated");

    // Exactly one append-only status_change event — attributable to the actor, source operator_manual.
    const events = await db
      .select()
      .from(tripEvents)
      .where(and(eq(tripEvents.tripId, tripId), eq(tripEvents.eventType, "status_change")));
    expect(events).toHaveLength(1);
    expect(events[0]!.statusAfter).toBe("validated");
    expect(events[0]!.source).toBe("operator_manual");
    expect(events[0]!.actorUserId).toBeTruthy();

    // One append-only audit row for the status change.
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, tripId), eq(auditLogs.action, "trip.status_change")));
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  test("a non-holder (Finance) is refused 403 and the Validar button is not rendered", async ({
    request,
    page,
  }) => {
    const tripId = await seedTrip("received");

    // API: Finance lacks `update_trip_status` → 403.
    const ctx = await apiLogin(request, testAccounts.nonAdmin);
    const res = await ctx.post(`/api/trips/${tripId}/status`, {
      data: { expectedFromStatus: "received", toStatus: "validated", source: "operator_manual" },
    });
    expect(res.status()).toBe(403);

    // UI: the Validate card/button is not rendered for a non-holder on the received trip's detail.
    await login(page, testAccounts.nonAdmin);
    await page.goto(`/trips/${tripId}`);
    await expect(page.getByRole("button", { name: "Validar viagem" })).toHaveCount(0);
  });

  test("the Validar button shows for a holder on a received trip and not on a validated trip", async ({
    page,
  }) => {
    const receivedId = await seedTrip("received");
    const validatedId = await seedTrip("validated");

    await login(page, testAccounts.opsManager);

    await page.goto(`/trips/${receivedId}`);
    await expect(page.getByRole("button", { name: "Validar viagem" })).toBeVisible({ timeout: 15_000 });

    await page.goto(`/trips/${validatedId}`);
    await expect(page.getByRole("button", { name: "Validar viagem" })).toHaveCount(0);
  });

  test("Ops Manager rejects a received trip → validation_error with the reason on the event (011)", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const tripId = await seedTrip("received");

    const reason = "Destino não reconhecido (teste 011)";
    const res = await ctx.post(`/api/trips/${tripId}/status`, {
      data: {
        expectedFromStatus: "received",
        toStatus: "validation_error",
        source: "operator_manual",
        notes: reason,
      },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { item: { currentStatus: string } };
    expect(body.item.currentStatus).toBe("validation_error");

    // The reject reason is persisted on the append-only status_change event (the existing notes field).
    const events = await db
      .select()
      .from(tripEvents)
      .where(and(eq(tripEvents.tripId, tripId), eq(tripEvents.eventType, "status_change")));
    expect(events).toHaveLength(1);
    expect(events[0]!.statusAfter).toBe("validation_error");
    expect(events[0]!.notes).toBe(reason);
    expect(events[0]!.source).toBe("operator_manual");
  });

  test("the validation_error → received correction is available and works", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const tripId = await seedTrip("validation_error");

    const res = await ctx.post(`/api/trips/${tripId}/status`, {
      data: { expectedFromStatus: "validation_error", toStatus: "received", source: "operator_manual" },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { item: { currentStatus: string } };
    expect(body.item.currentStatus).toBe("received");
  });
});
