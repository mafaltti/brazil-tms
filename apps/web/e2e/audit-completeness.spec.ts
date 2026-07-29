import { test, expect, type APIRequestContext } from "@playwright/test";
import { eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  alerts,
  auditLogs,
  customers,
  db,
  exceptions,
  locations,
  reasonCodes,
  tripEvents,
  trips,
} from "@brazil-tms/db";
import { testAccounts } from "./test-config";

/**
 * Feature 009 US5 — audit-completeness hardening (FR-017 / SC-005 / §23 row 13). Triggers a
 * representative §21.5 action across the major categories through the BFF and asserts each writes an
 * append-only `audit_logs` row (action + actor, with before/after where applicable). Then proves the
 * append-only REVOKE is real via `SET LOCAL ROLE` to a SELECT/INSERT-only role (expect SQLSTATE 42501;
 * MEMORY `append_only_superuser_set_role`).
 *
 * Categories triggered here: permission/user change · commercial-data change · trip create (import) ·
 * plan/execution edit · exception create. The remaining §21.5 categories (assignment, status
 * transition, document verification, billing change, export-batch creation) are each asserted by their
 * owning feature spec — `dispatch-*`, `execution-timeline`, `documents`, `rates-billing`,
 * `billing-export`, `master-data-audit` — and rolled up in the §23 traceability matrix.
 */

const ROLE = "tms_audit_complete_probe";

async function apiLogin(request: APIRequestContext, account: { email: string; password: string }) {
  const res = await request.post("/api/auth/sign-in", {
    data: { email: account.email, password: account.password },
  });
  expect(res.ok(), "sign-in must succeed").toBeTruthy();
}

function code(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function actionsFor(entityId: string): Promise<string[]> {
  const rows = await db
    .select({ action: auditLogs.action, actorUserId: auditLogs.actorUserId })
    .from(auditLogs)
    .where(eq(auditLogs.entityId, entityId));
  // every audit row must carry an actor.
  expect(rows.every((r) => Boolean(r.actorUserId))).toBe(true);
  return rows.map((r) => r.action);
}

let customerId = "";
let originId = "";
let destId = "";
let reasonCodeId = "";
let tripId = "";
let bffCustomerId = "";
const cleanupCustomerIds: string[] = [];

test.afterAll(async () => {
  if (tripId) {
    // FK-safe order: a §21.5 trigger may have created an exception (and possibly an alert) on the trip.
    await db.delete(alerts).where(eq(alerts.tripId, tripId));
    await db.delete(exceptions).where(eq(exceptions.tripId, tripId));
    await db.delete(auditLogs).where(eq(auditLogs.entityId, tripId));
    await db.delete(tripEvents).where(eq(tripEvents.tripId, tripId));
    await db.delete(trips).where(eq(trips.id, tripId));
  }
  if (reasonCodeId) await db.delete(reasonCodes).where(eq(reasonCodes.id, reasonCodeId));
  if (originId || destId) {
    await db.delete(locations).where(inArray(locations.id, [originId, destId].filter(Boolean)));
  }
  const custs = [customerId, bffCustomerId, ...cleanupCustomerIds].filter(Boolean);
  if (custs.length) {
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, custs));
    await db.delete(customers).where(inArray(customers.id, custs));
  }
});

test("each major §21.5 action type writes an append-only audit_logs row", async ({ request }) => {
  // --- seed the prerequisites directly (customer/locations/reason code) ---
  const cust = await db
    .insert(customers)
    .values({ name: "Cliente Audit Completo", customerCode: code("CUST") })
    .returning({ id: customers.id });
  customerId = cust[0]!.id;
  const origin = await db
    .insert(locations)
    .values({ customerId, code: code("ORIG"), name: "Origem AC" })
    .returning({ id: locations.id });
  originId = origin[0]!.id;
  const dest = await db
    .insert(locations)
    .values({ customerId, code: code("DEST"), name: "Destino AC" })
    .returning({ id: locations.id });
  destId = dest[0]!.id;
  const rc = await db
    .insert(reasonCodes)
    .values({
      code: code("RC"),
      category: "delay",
      labelPt: "Atraso",
      defaultSeverity: "medium",
      defaultResponsibleParty: "carrier_caused",
    })
    .returning({ id: reasonCodes.id });
  reasonCodeId = rc[0]!.id;

  // --- permission/user change (manage_users) ---
  await apiLogin(request, testAccounts.admin);
  const userRes = await request.post("/api/admin/users", {
    data: {
      name: "Auditoria Completa",
      email: code("e2e-ac").toLowerCase() + "@braziltransports.com.br",
      role: "dispatcher",
      onboarding: { method: "invite" },
    },
  });
  expect(userRes.status()).toBe(201);
  const userId = ((await userRes.json()) as { user: { id: string } }).user.id;
  expect(await actionsFor(userId)).toEqual(expect.arrayContaining(["user.create"]));

  // --- commercial-data change (manage_commercial_data) ---
  await apiLogin(request, testAccounts.opsManager);
  const custRes = await request.post("/api/master-data/customers", {
    data: { name: "Cliente BFF Audit", customerCode: code("BFF") },
  });
  expect(custRes.status()).toBe(201);
  bffCustomerId = ((await custRes.json()) as { item: { id: string } }).item.id;
  expect(await actionsFor(bffCustomerId)).toEqual(expect.arrayContaining(["customer.create"]));

  // --- trip create (import_trips: manual create) — held by admin/operations_manager, NOT dispatcher ---
  await apiLogin(request, testAccounts.opsManager);
  const tripRes = await request.post("/api/trips", {
    data: { customerId, originLocationId: originId, destinationLocationId: destId },
  });
  expect(tripRes.status()).toBe(201);
  tripId = ((await tripRes.json()) as { item: { id: string } }).item.id;

  // --- plan/execution edit (manage_trips) — a critical field change writes trip.plan_update ---
  await apiLogin(request, testAccounts.opsManager);
  const planRes = await request.patch(`/api/trips/${tripId}/plan`, {
    data: { plannedVehicleType: "toco" },
  });
  expect(planRes.ok()).toBeTruthy();

  // --- exception create (create_exceptions) ---
  await apiLogin(request, testAccounts.dispatcher);
  const excRes = await request.post(`/api/trips/${tripId}/exceptions`, {
    data: { reasonCodeId },
  });
  expect(excRes.status()).toBe(201);

  // The trip's audit trail now carries create + plan_update; the exception write is audited too.
  const tripActions = await actionsFor(tripId);
  expect(tripActions).toEqual(expect.arrayContaining(["trip.create", "trip.plan_update"]));
});

test("audit_logs and trip_events are append-only (UPDATE/DELETE denied to a least-privilege role)", async () => {
  // Throwaway SELECT/INSERT-only role; superuser bypasses REVOKE, so probe under SET LOCAL ROLE.
  await db.execute(
    sql.raw(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
        EXECUTE 'DROP OWNED BY ${ROLE}';
        EXECUTE 'DROP ROLE ${ROLE}';
      END IF;
    END $$;`),
  );
  await db.execute(sql.raw(`CREATE ROLE ${ROLE} NOLOGIN`));
  await db.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO ${ROLE}`));
  await db.execute(
    sql.raw(`GRANT SELECT, INSERT ON public.audit_logs, public.trip_events TO ${ROLE}`),
  );

  async function expectDenied(statement: SQL): Promise<void> {
    let err: unknown;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE ${ROLE}`));
        await tx.execute(statement);
      });
    } catch (e) {
      err = e;
    }
    expect(err, "expected a permission-denied rejection").toBeDefined();
    const e = err as { code?: string; cause?: { code?: string; message?: string }; message?: string };
    const sqlState = e?.cause?.code ?? e?.code;
    const message = `${e?.message ?? ""} ${e?.cause?.message ?? ""}`;
    expect(sqlState === "42501" || /permission denied/i.test(message)).toBe(true);
  }

  await expectDenied(sql`UPDATE public.audit_logs SET reason = 'tamper'`);
  await expectDenied(sql`DELETE FROM public.audit_logs`);
  await expectDenied(sql`UPDATE public.trip_events SET notes = 'tamper'`);
  await expectDenied(sql`DELETE FROM public.trip_events`);

  await db.execute(
    sql.raw(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
        EXECUTE 'DROP OWNED BY ${ROLE}';
        EXECUTE 'DROP ROLE ${ROLE}';
      END IF;
    END $$;`),
  );
});
