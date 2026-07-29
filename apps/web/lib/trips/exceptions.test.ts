import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  alerts,
  auditLogs,
  createException,
  customers,
  db,
  exceptions,
  locations,
  reasonCodes,
  transitionException,
  trips,
  updateException,
  users,
} from "@brazil-tms/db";
import type { TripStatus } from "@brazil-tms/shared";

/**
 * Feature 007 US2 — exception lifecycle integration test (live dev DB). Static imports; uses the
 * SEEDED admin as actor (no `users` insert — it FKs to GoTrue). Seeds its own customer/locations +
 * two reason codes (a high-severity one to exercise the SLA/alert trigger). FK-safe cleanup. Skips
 * without DATABASE_URL.
 *
 * Covers: createException (reason-code defaults pre-fill, owner defaults to actor, INVALID_REASON_CODE,
 * exception.create audit, high-sev generateAlert fires + recompute → At Risk, responsible_party incl.
 * force_majeure + derived category persisted/readable — FR-012); updateException; transitionException
 * (STALE_EXCEPTION, ILLEGAL_EXCEPTION_TRANSITION, closure-notes-on-Resolve sets resolved_at, terminal
 * no-reopen, high-sev close auto-resolves its alert + recompute).
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("exceptions (integration)", () => {
  let actorId = "";
  let customerId = "";
  let originId = "";
  let destId = "";
  let highReasonId = "";
  let lowReasonId = "";
  const createdTripIds: string[] = [];
  const createdReasonIds: string[] = [];

  function code(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  /** A trip with a known active status + a planned pickup window, so SLA can evaluate. */
  async function createTripAt(currentStatus: TripStatus): Promise<string> {
    const inserted = await db
      .insert(trips)
      .values({
        customerId,
        originLocationId: originId,
        destinationLocationId: destId,
        originalPlan: {},
        currentStatus,
        plannedPickupWindowStart: new Date("2026-09-01T08:00:00.000Z"),
        plannedPickupWindowEnd: new Date("2026-09-01T10:00:00.000Z"),
      })
      .returning();
    const id = inserted[0]!.id;
    createdTripIds.push(id);
    return id;
  }

  async function openHighSevExceptionId(tripId: string): Promise<string> {
    const rows = await db
      .select({ id: exceptions.id })
      .from(exceptions)
      .where(and(eq(exceptions.tripId, tripId), eq(exceptions.severity, "high")))
      .limit(1);
    return rows[0]!.id;
  }

  beforeAll(async () => {
    const admin = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "admin@braziltransports.com.br"))
      .limit(1);
    actorId = admin[0]?.id ?? "";
    expect(actorId, "seeded admin must exist (run db:seed)").not.toBe("");

    const cust = await db.insert(customers).values({ name: "Cliente Exc", customerCode: code("CUST") }).returning();
    customerId = cust[0]!.id;
    const origin = await db.insert(locations).values({ customerId, code: code("ORIG"), name: "Origem" }).returning();
    originId = origin[0]!.id;
    const dest = await db.insert(locations).values({ customerId, code: code("DEST"), name: "Destino" }).returning();
    destId = dest[0]!.id;

    const high = await db
      .insert(reasonCodes)
      .values({ code: code("RC-HIGH"), category: "breakdown", labelPt: "Pane (alta)", defaultSeverity: "high", defaultResponsibleParty: "carrier_caused" })
      .returning();
    highReasonId = high[0]!.id;
    createdReasonIds.push(highReasonId);

    const low = await db
      .insert(reasonCodes)
      .values({ code: code("RC-LOW"), category: "documentation", labelPt: "Doc (baixa)", defaultSeverity: "low", defaultResponsibleParty: "unknown" })
      .returning();
    lowReasonId = low[0]!.id;
    createdReasonIds.push(lowReasonId);
  });

  afterAll(async () => {
    for (const id of createdTripIds) {
      await db.delete(alerts).where(eq(alerts.tripId, id));
      await db.delete(exceptions).where(eq(exceptions.tripId, id));
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(trips).where(eq(trips.id, id));
    }
    // exception.* audit rows key on the exception id, not the trip id — clear by actor's reason codes.
    if (createdReasonIds.length) await db.delete(reasonCodes).where(inArray(reasonCodes.id, createdReasonIds));
    await db.delete(locations).where(inArray(locations.id, [originId, destId]));
    await db.delete(customers).where(eq(customers.id, customerId));
  });

  it("createException pre-fills reason-code defaults, defaults owner to the actor, derives the category", async () => {
    const tripId = await createTripAt("confirmed");
    const detail = await createException(tripId, { reasonCodeId: lowReasonId }, actorId);

    expect(detail.exceptions).toHaveLength(1);
    const exc = detail.exceptions[0]!;
    expect(exc.severity).toBe("low"); // from reason-code default
    expect(exc.responsibleParty).toBe("unknown"); // from reason-code default
    expect(exc.ownerUserId).toBe(actorId); // owner defaults to actor
    expect(exc.category).toBe("documentation"); // DERIVED from the reason code
    expect(exc.status).toBe("open");

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, exc.id), eq(auditLogs.action, "exception.create")));
    expect(audit).toHaveLength(1);
  });

  it("rejects an unknown/inactive reason code with INVALID_REASON_CODE", async () => {
    const tripId = await createTripAt("confirmed");
    await expect(
      createException(tripId, { reasonCodeId: "11111111-1111-1111-1111-111111111111" }, actorId),
    ).rejects.toMatchObject({ code: "INVALID_REASON_CODE" });
  });

  it("a high-severity exception fires its alert and recomputes SLA → at_risk; force_majeure persists", async () => {
    const tripId = await createTripAt("confirmed");
    const detail = await createException(
      tripId,
      { reasonCodeId: highReasonId, responsibleParty: "force_majeure" },
      actorId,
    );

    const exc = detail.exceptions[0]!;
    expect(exc.severity).toBe("high");
    expect(exc.responsibleParty).toBe("force_majeure"); // the 5th value persists/reads (billing-dispute use)

    // SLA recompute → at_risk (open high-severity exception is a trigger).
    expect(detail.slaStatus).toBe("at_risk");
    expect(detail.slaReasons).toContain("open_high_severity_exception");

    // The synchronous high-severity alert was raised (one active row).
    const alertRows = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.tripId, tripId), eq(alerts.alertCase, "high_severity_exception")));
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0]!.state).toBe("active");
  });

  it("updateException edits a non-terminal exception (audited)", async () => {
    const tripId = await createTripAt("confirmed");
    const created = await createException(tripId, { reasonCodeId: lowReasonId }, actorId);
    const excId = created.exceptions[0]!.id;

    const updated = await updateException(excId, { description: "Atualizado." }, actorId);
    expect(updated.exceptions[0]!.description).toBe("Atualizado.");

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, excId), eq(auditLogs.action, "exception.update")));
    expect(audit).toHaveLength(1);
  });

  it("transitionException: Open→Monitoring→Resolved (closure notes), terminal no-reopen; high-sev close auto-resolves its alert", async () => {
    const tripId = await createTripAt("confirmed");
    await createException(tripId, { reasonCodeId: highReasonId }, actorId);
    const excId = await openHighSevExceptionId(tripId);

    // Open → Monitoring.
    await transitionException(excId, { expectedFromStatus: "open", toStatus: "monitoring" }, actorId);

    // ILLEGAL: Monitoring → Open is legal, but Resolved → anything is terminal (checked below). First a
    // stale guard: claiming the wrong from-status.
    await expect(
      transitionException(excId, { expectedFromStatus: "open", toStatus: "resolved", closureNotes: "x" }, actorId),
    ).rejects.toMatchObject({ code: "STALE_EXCEPTION" });

    // Monitoring → Resolved (closure notes required by the schema; the service persists resolved_at).
    const resolved = await transitionException(
      excId,
      { expectedFromStatus: "monitoring", toStatus: "resolved", closureNotes: "Resolvido com a transportadora." },
      actorId,
    );
    const exc = resolved.exceptions.find((e) => e.id === excId)!;
    expect(exc.status).toBe("resolved");
    expect(exc.resolvedAt).not.toBeNull();
    expect(exc.closureNotes).toBe("Resolvido com a transportadora.");

    // Terminal — no reopen.
    await expect(
      transitionException(excId, { expectedFromStatus: "resolved", toStatus: "open" }, actorId),
    ).rejects.toMatchObject({ code: "ILLEGAL_EXCEPTION_TRANSITION" });

    // The last high-severity exception closed ⇒ its alert auto-resolved, SLA cleared back to on_track.
    const alertRows = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.tripId, tripId), eq(alerts.alertCase, "high_severity_exception")));
    expect(alertRows[0]!.state).toBe("resolved");
    const [trip] = await db.select({ s: trips.slaStatus }).from(trips).where(eq(trips.id, tripId));
    expect(trip!.s).toBe("on_track");
  });
});
