import { and, count, eq, inArray } from "drizzle-orm";
import { db } from "../client";
import { exceptions, reasonCodes, trips } from "../../schema";
import {
  canTransitionException,
  type CreateExceptionInput,
  type TransitionExceptionInput,
  type UpdateExceptionInput,
} from "@brazil-tms/shared";
import { writeAudit } from "../audit/write-audit";
import { Conflict } from "../errors";
import { autoResolveAlert, generateAlert } from "./alerts";
import { recomputeTripSla } from "./sla";
import { loadTripDetail, type TripDetail } from "./trip-dto";

/**
 * Feature 007 US2 — exception lifecycle services (data-model §11.1). Each mirrors `transitionTripStatus`:
 * pre-tx legality (so a refused action changes NO state) → one transaction doing a guarded conditional
 * UPDATE (+ INSERT) + `writeAudit` + the high-severity alert sync + `recomputeTripSla` → return
 * `loadTripDetail`. A high-severity exception is the FR-012 SLA/alert trigger; the alert is generated
 * synchronously here and the worker sweep is a backstop (US4). All conflicts throw `Conflict(code, ptBR)`.
 */

type Executor = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Recompute the synchronous high-severity-exception alert from the trip's CURRENT open/monitoring
 * high-severity exception count: raise it when ≥1 remains, auto-resolve it when none do (idempotent).
 * Called inside the mutation tx after the exception row settles.
 */
async function syncHighSeverityAlert(tx: Executor, tripId: string): Promise<void> {
  const rows = await tx
    .select({ value: count() })
    .from(exceptions)
    .where(
      and(
        eq(exceptions.tripId, tripId),
        inArray(exceptions.status, ["open", "monitoring"]),
        eq(exceptions.severity, "high"),
      ),
    );
  if ((rows[0]?.value ?? 0) > 0) {
    await generateAlert(tx, tripId, "high_severity_exception", "high");
  } else {
    await autoResolveAlert(tx, tripId, "high_severity_exception");
  }
}

/**
 * Create an exception on a trip (FR-008..FR-012). The reason code suggests default severity +
 * responsible party (overridable); the owner defaults to the creating actor; the category is DERIVED
 * from the reason code (never stored). A high-severity exception raises its alert synchronously and
 * recomputes SLA → At Risk.
 */
export async function createException(
  tripId: string,
  input: CreateExceptionInput,
  actorUserId: string,
): Promise<TripDetail> {
  const tripRows = await db.select({ id: trips.id }).from(trips).where(eq(trips.id, tripId)).limit(1);
  if (!tripRows[0]) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");

  const codeRows = await db
    .select({
      id: reasonCodes.id,
      active: reasonCodes.active,
      defaultSeverity: reasonCodes.defaultSeverity,
      defaultResponsibleParty: reasonCodes.defaultResponsibleParty,
    })
    .from(reasonCodes)
    .where(eq(reasonCodes.id, input.reasonCodeId))
    .limit(1);
  const code = codeRows[0];
  if (!code || !code.active) {
    throw new Conflict("INVALID_REASON_CODE", "Código de motivo inválido ou inativo.");
  }

  const severity = input.severity ?? code.defaultSeverity;
  const responsibleParty = input.responsibleParty ?? code.defaultResponsibleParty;
  const ownerUserId = input.ownerUserId ?? actorUserId;

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(exceptions)
      .values({
        tripId,
        reasonCodeId: input.reasonCodeId,
        severity,
        status: "open",
        responsibleParty,
        ownerUserId,
        description: input.description ?? "",
        createdByUserId: actorUserId,
      })
      .returning();

    await writeAudit(tx, {
      entityType: "exception",
      entityId: created!.id,
      action: "exception.create",
      previousValue: null,
      newValue: { tripId, reasonCodeId: input.reasonCodeId, severity, responsibleParty, ownerUserId },
      actorUserId,
    });

    if (severity === "high") {
      await generateAlert(tx, tripId, "high_severity_exception", "high");
    }
    await recomputeTripSla(tx, tripId);

    const detail = await loadTripDetail(tx, tripId);
    if (!detail) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");
    return detail;
  });
}

/**
 * Edit a non-terminal exception's owner / severity / responsible-party / description (FR-008). A
 * severity flip to/from `high` adds or auto-resolves the high-severity alert; SLA is recomputed.
 */
export async function updateException(
  exceptionId: string,
  input: UpdateExceptionInput,
  actorUserId: string,
): Promise<TripDetail> {
  const rows = await db
    .select({ tripId: exceptions.tripId, status: exceptions.status })
    .from(exceptions)
    .where(eq(exceptions.id, exceptionId))
    .limit(1);
  const existing = rows[0];
  if (!existing) throw new Conflict("NOT_FOUND", "Exceção não encontrada.");
  if (existing.status === "resolved" || existing.status === "cancelled") {
    throw new Conflict("STALE_EXCEPTION", "A exceção já foi encerrada.");
  }

  const patch: Partial<typeof exceptions.$inferInsert> = { updatedAt: new Date() };
  if (input.ownerUserId !== undefined) patch.ownerUserId = input.ownerUserId;
  if (input.severity !== undefined) patch.severity = input.severity;
  if (input.responsibleParty !== undefined) patch.responsibleParty = input.responsibleParty;
  if (input.description !== undefined) patch.description = input.description;

  return db.transaction(async (tx) => {
    // Guarded on non-terminal status (concurrent close ⇒ 0 rows ⇒ STALE_EXCEPTION).
    const updated = await tx
      .update(exceptions)
      .set(patch)
      .where(and(eq(exceptions.id, exceptionId), inArray(exceptions.status, ["open", "monitoring"])))
      .returning();
    if (updated.length === 0) throw new Conflict("STALE_EXCEPTION", "A exceção já foi encerrada.");

    await writeAudit(tx, {
      entityType: "exception",
      entityId: exceptionId,
      action: "exception.update",
      previousValue: null,
      newValue: { ...input },
      actorUserId,
    });

    await syncHighSeverityAlert(tx, existing.tripId);
    await recomputeTripSla(tx, existing.tripId);

    const detail = await loadTripDetail(tx, existing.tripId);
    if (!detail) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");
    return detail;
  });
}

/**
 * Transition an exception (FR-009): Open↔Monitoring; →Resolved/Cancelled (terminal). Closure notes
 * are required on Resolve (enforced by the Zod schema). Legality is checked pre-tx; the in-tx UPDATE
 * is guarded on `expectedFromStatus` (0 rows ⇒ STALE_EXCEPTION). Closing a high-severity exception
 * auto-resolves its alert when no open high-severity exception remains.
 */
export async function transitionException(
  exceptionId: string,
  input: TransitionExceptionInput,
  actorUserId: string,
): Promise<TripDetail> {
  const rows = await db
    .select({ tripId: exceptions.tripId, status: exceptions.status })
    .from(exceptions)
    .where(eq(exceptions.id, exceptionId))
    .limit(1);
  const existing = rows[0];
  if (!existing) throw new Conflict("NOT_FOUND", "Exceção não encontrada.");

  if (!canTransitionException(input.expectedFromStatus, input.toStatus)) {
    throw new Conflict("ILLEGAL_EXCEPTION_TRANSITION", "Transição de exceção não permitida.");
  }

  const action =
    input.toStatus === "resolved"
      ? "exception.resolve"
      : input.toStatus === "cancelled"
        ? "exception.cancel"
        : "exception.update";

  return db.transaction(async (tx) => {
    const patch: Partial<typeof exceptions.$inferInsert> = {
      status: input.toStatus,
      updatedAt: new Date(),
    };
    if (input.toStatus === "resolved") {
      patch.resolvedAt = new Date();
      patch.closureNotes = input.closureNotes ?? null;
    }

    const updated = await tx
      .update(exceptions)
      .set(patch)
      .where(and(eq(exceptions.id, exceptionId), eq(exceptions.status, input.expectedFromStatus)))
      .returning();
    if (updated.length === 0) {
      throw new Conflict("STALE_EXCEPTION", "A exceção já mudou de estado.");
    }

    await writeAudit(tx, {
      entityType: "exception",
      entityId: exceptionId,
      action,
      previousValue: { status: input.expectedFromStatus },
      newValue: { status: input.toStatus, closureNotes: patch.closureNotes ?? null },
      actorUserId,
    });

    await syncHighSeverityAlert(tx, existing.tripId);
    await recomputeTripSla(tx, existing.tripId);

    const detail = await loadTripDetail(tx, existing.tripId);
    if (!detail) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");
    return detail;
  });
}
