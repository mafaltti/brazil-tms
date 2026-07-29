import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql, type SQL } from "drizzle-orm";
import { auditLogs, customers, db, locations, tripEvents, trips, users } from "@brazil-tms/db";
import { createTrip } from "./trips-service";
import { updateTripPlan } from "./trip-plan";

/**
 * US3 (T027) — append-only immutability of `trip_events` and `audit_logs` (FR-017, SC-003), and the
 * never-overwritten `original_plan` (SC-002). Integration test against the live dev DB.
 *
 * Note on the test connection: the dev `DATABASE_URL` connects as the `postgres` SUPERUSER, which
 * bypasses GRANT/REVOKE. So to prove the append-only `REVOKE UPDATE, DELETE ... FROM PUBLIC` is real
 * (and not defeated by superuser), each attempt runs under `SET LOCAL ROLE` to a throwaway,
 * non-superuser role granted only SELECT+INSERT — exactly the restricted app role the migration's
 * REVOKE protects. Under that role, UPDATE/DELETE must be denied (SQLSTATE 42501). This mirrors the
 * production posture where the BFF would connect as a least-privilege role.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const ROLE = "tms_append_only_probe";

describe.skipIf(!hasDb)("trip events/audit append-only immutability (integration, US3)", () => {
  let actorId = "";
  let customerId = "";
  let originId = "";
  let destId = "";
  let tripId = "";
  let eventId = "";
  let auditId = "";

  function code(prefix = "IMMUT-TEST"): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  /**
   * Run `statement` under the restricted (non-superuser) role inside a transaction and assert it is
   * rejected for lack of privilege. `SET LOCAL ROLE` is scoped to the transaction; the failing
   * statement aborts and rolls back, so nothing is mutated.
   */
  async function expectAppendOnlyDenied(statement: SQL): Promise<void> {
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
    const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
    const sqlState = e?.cause?.code ?? e?.code;
    const message = `${e?.message ?? ""} ${e?.cause?.message ?? ""}`;
    expect(sqlState === "42501" || /permission denied/i.test(message)).toBe(true);
  }

  beforeAll(async () => {
    const admin = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "admin@braziltransports.com.br"))
      .limit(1);
    actorId = admin[0]?.id ?? "";
    expect(actorId, "seeded admin must exist (run db:seed)").not.toBe("");

    const cust = await db
      .insert(customers)
      .values({ name: "Cliente Imutável", customerCode: code("CUST") })
      .returning();
    customerId = cust[0]!.id;
    const origin = await db
      .insert(locations)
      .values({ customerId, code: code("ORIG"), name: "Origem Im" })
      .returning();
    originId = origin[0]!.id;
    const dest = await db
      .insert(locations)
      .values({ customerId, code: code("DEST"), name: "Destino Im" })
      .returning();
    destId = dest[0]!.id;

    // A trip + its create audit row, and one trip_event to target.
    const trip = await createTrip(
      { customerId, originLocationId: originId, destinationLocationId: destId },
      actorId,
    );
    tripId = trip.id;

    const ev = await db
      .insert(tripEvents)
      .values({
        tripId,
        eventType: "origin_arrived",
        source: "operator_manual",
        actorUserId: actorId,
        eventTimestamp: new Date(),
      })
      .returning({ id: tripEvents.id });
    eventId = ev[0]!.id;

    const aud = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.entityId, tripId))
      .limit(1);
    auditId = aud[0]!.id;

    // Throwaway least-privilege role: SELECT + INSERT only (NO update/delete). Drop any residue first.
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
      sql.raw(`GRANT SELECT, INSERT ON public.trip_events, public.audit_logs TO ${ROLE}`),
    );
  });

  afterAll(async () => {
    await db.execute(
      sql.raw(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
          EXECUTE 'DROP OWNED BY ${ROLE}';
          EXECUTE 'DROP ROLE ${ROLE}';
        END IF;
      END $$;`),
    );
    if (tripId) {
      await db.delete(tripEvents).where(eq(tripEvents.tripId, tripId));
      await db.delete(auditLogs).where(eq(auditLogs.entityId, tripId));
      await db.delete(trips).where(eq(trips.id, tripId));
    }
    for (const id of [originId, destId]) {
      if (id) await db.delete(locations).where(eq(locations.id, id));
    }
    if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
  });

  it("direct UPDATE on a trip_events row is rejected by DB privileges", async () => {
    await expectAppendOnlyDenied(
      sql`UPDATE public.trip_events SET notes = 'tamper' WHERE id = ${eventId}`,
    );
  });

  it("direct DELETE on a trip_events row is rejected by DB privileges", async () => {
    await expectAppendOnlyDenied(sql`DELETE FROM public.trip_events WHERE id = ${eventId}`);
  });

  it("direct UPDATE on an audit_logs row is rejected by DB privileges", async () => {
    await expectAppendOnlyDenied(
      sql`UPDATE public.audit_logs SET reason = 'tamper' WHERE id = ${auditId}`,
    );
  });

  it("direct DELETE on an audit_logs row is rejected by DB privileges", async () => {
    await expectAppendOnlyDenied(sql`DELETE FROM public.audit_logs WHERE id = ${auditId}`);
  });

  it("original_plan is unchanged across plan updates (SC-002)", async () => {
    const before = await db
      .select({ originalPlan: trips.originalPlan })
      .from(trips)
      .where(eq(trips.id, tripId))
      .limit(1);
    const original = before[0]!.originalPlan;

    // Two accepted live-plan updates (critical + non-critical) must never touch original_plan.
    await updateTripPlan(tripId, { plannedVehicleType: "toco" }, {}, actorId);
    await updateTripPlan(tripId, { plannedRouteNotes: "desvio" }, {}, actorId);

    const after = await db
      .select({ originalPlan: trips.originalPlan })
      .from(trips)
      .where(eq(trips.id, tripId))
      .limit(1);
    expect(after[0]!.originalPlan).toEqual(original);
  });
});
