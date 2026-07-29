import { test, expect, type APIRequestContext } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";
import { auditLogs, customers, db, locations, tripEvents, trips, users } from "@brazil-tms/db";
import { testAccounts } from "./test-config";

/**
 * US2 (Trip Detail view) + US3 (inline operational-field edit before completion) — drives the
 * `GET /api/trips/:id` enriched detail and the `PATCH /api/trips/:id/plan` edit against the running
 * app (T0xx).
 *
 * Authorization split: READS are gated `view_all_trips` (held by all seven internal roles); EDITS keep
 * `manage_trips` (only Admin + Ops Manager). So Ops Manager reads + edits; Dispatcher reads but is
 * refused the edit (403). Editing is hard-blocked once a trip is at/after completion
 * (409 EDIT_NOT_ALLOWED).
 *
 * Self-seeds (a Playwright spec cannot import the `server-only` services): one customer + two
 * locations + TWO trips — one editable (`received`) and one non-editable (`completed`) — each with an
 * immutable `original_plan`, one `status_change` trip_event, and one `trip.status_change` audit row.
 * Requires DATABASE_URL for the test process.
 *
 * Login: Ops Manager (`testAccounts.opsManager`) for authorized read + edit; Dispatcher
 * (`testAccounts.dispatcher`) for the edit denial. The seeded Admin is `must_change_password=true`, so
 * it cannot be used for API login.
 */

const ADMIN_EMAIL = "admin@braziltransports.com.br";

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
  expect(res.ok()).toBeTruthy();
  return request;
}

let customerId = "";
let originId = "";
let destId = "";
let receivedId = "";
let completedId = "";
let actorId = "";
const tripIds: string[] = [];

async function seedTrip(
  externalTripId: string,
  currentStatus: (typeof trips.$inferSelect)["currentStatus"],
  statusBefore: (typeof trips.$inferSelect)["currentStatus"],
): Promise<string> {
  const originalPlan = {
    customerId,
    originLocationId: originId,
    destinationLocationId: destId,
    plannedVehicleType: "truck",
  };
  const inserted = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId,
      originLocationId: originId,
      destinationLocationId: destId,
      currentStatus,
      originalPlan,
      plannedVehicleType: "truck",
    })
    .returning({ id: trips.id });
  const id = inserted[0]!.id;
  tripIds.push(id);

  await db.insert(tripEvents).values({
    tripId: id,
    eventType: "status_change",
    statusBefore,
    statusAfter: currentStatus,
    source: "system",
    actorUserId: actorId,
    eventTimestamp: new Date(),
  });

  await db.insert(auditLogs).values({
    entityType: "trip",
    entityId: id,
    action: "trip.status_change",
    previousValue: { currentStatus: statusBefore },
    newValue: { currentStatus },
    actorUserId: actorId,
  });

  return id;
}

test.beforeAll(async () => {
  const admin = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, ADMIN_EMAIL))
    .limit(1);
  actorId = admin[0]?.id ?? "";
  expect(actorId, "seeded admin must exist (run db:seed)").not.toBe("");

  const cust = await db
    .insert(customers)
    .values({ name: "Cliente Detalhe", customerCode: code("CUST") })
    .returning({ id: customers.id });
  customerId = cust[0]!.id;

  const origin = await db
    .insert(locations)
    .values({ customerId, code: code("ORIG"), name: "Origem Detalhe" })
    .returning({ id: locations.id });
  originId = origin[0]!.id;

  const dest = await db
    .insert(locations)
    .values({ customerId, code: code("DEST"), name: "Destino Detalhe" })
    .returning({ id: locations.id });
  destId = dest[0]!.id;

  receivedId = await seedTrip(code("EXT-VAL"), "received", "received");
  completedId = await seedTrip(code("EXT-DONE"), "completed", "unloaded");
});

test.afterAll(async () => {
  // FK-safe order: trip_events + audit (by tripId / entityId) → trips → locations → customers.
  if (tripIds.length) {
    await db.delete(tripEvents).where(inArray(tripEvents.tripId, tripIds));
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, tripIds));
    await db.delete(trips).where(inArray(trips.id, tripIds));
  }
  for (const id of [originId, destId]) {
    if (id) await db.delete(locations).where(eq(locations.id, id));
  }
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

test.describe("US2 — Trip Detail view (enriched read)", () => {
  test("Ops Manager → 200 with events + audit + name enrichment + null billingStatus", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const res = await ctx.get(`/api/trips/${receivedId}`);
    expect(res.status()).toBe(200);
    const { item } = (await res.json()) as {
      item: {
        id: string;
        currentStatus: string;
        billingStatus: string | null;
        customerName: string;
        originName: string;
        events: Array<{ eventType: string }>;
        audit: Array<{ action: string }>;
      };
    };
    expect(item.id).toBe(receivedId);
    expect(item.events.some((e) => e.eventType === "status_change")).toBe(true);
    expect(item.audit.some((a) => a.action === "trip.status_change")).toBe(true);
    expect(item.customerName).toBeTruthy();
    expect(item.originName).toBeTruthy();
    // `received` is not a billing-phase status → derived projection is null.
    expect(item.billingStatus).toBeNull();
  });

  test("unknown id → 404", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const res = await ctx.get("/api/trips/00000000-0000-0000-0000-000000000000");
    expect(res.status()).toBe(404);
  });
});

test.describe("US3 — inline operational-field edit before completion", () => {
  test("Ops Manager edit of a critical field → 200 + new trip.plan_update audit", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);

    // `plannedVehicleType` is a CRITICAL field, so the change writes a `trip.plan_update` audit row.
    const patch = await ctx.patch(`/api/trips/${receivedId}/plan`, {
      data: { plannedVehicleType: "carreta" },
    });
    expect(patch.status()).toBe(200);
    const patched = (await patch.json()) as { item: { plannedVehicleType: string | null } };
    expect(patched.item.plannedVehicleType).toBe("carreta");

    // A follow-up read reflects the update and surfaces the new audit action.
    const detail = await ctx.get(`/api/trips/${receivedId}`);
    expect(detail.status()).toBe(200);
    const { item } = (await detail.json()) as {
      item: { plannedVehicleType: string | null; audit: Array<{ action: string }> };
    };
    expect(item.plannedVehicleType).toBe("carreta");
    expect(item.audit.some((a) => a.action === "trip.plan_update")).toBe(true);
  });

  test("edit on a completed trip → 409 EDIT_NOT_ALLOWED", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const res = await ctx.patch(`/api/trips/${completedId}/plan`, {
      data: { plannedRouteNotes: "x" },
    });
    expect(res.status()).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("EDIT_NOT_ALLOWED");
  });

  test("Dispatcher (no manage_trips) edit → 403", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.dispatcher);
    const res = await ctx.patch(`/api/trips/${receivedId}/plan`, {
      data: { plannedRouteNotes: "x" },
    });
    expect(res.status()).toBe(403);
  });

  test("empty body → 400 (schema requires ≥1 field)", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const res = await ctx.patch(`/api/trips/${receivedId}/plan`, { data: {} });
    expect(res.status()).toBe(400);
  });

  test("partial edit inverting the MERGED pickup window → 409 INVALID_PLAN_WINDOW", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);

    // Establish a valid pickup window first.
    const seed = await ctx.patch(`/api/trips/${receivedId}/plan`, {
      data: {
        plannedPickupWindowStart: "2026-06-01T12:00:00.000Z",
        plannedPickupWindowEnd: "2026-06-01T15:00:00.000Z",
      },
    });
    expect(seed.status()).toBe(200);

    // Now send ONLY the end, earlier than the stored start → the merged window is invalid. The Zod
    // both-present check can't catch this; the locked-service guard must (no silent bad write).
    const res = await ctx.patch(`/api/trips/${receivedId}/plan`, {
      data: { plannedPickupWindowEnd: "2026-06-01T08:00:00.000Z" },
    });
    expect(res.status()).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_PLAN_WINDOW");
  });
});
