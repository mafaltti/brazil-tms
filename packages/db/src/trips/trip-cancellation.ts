import { and, asc, eq } from "drizzle-orm";
import { db } from "../client";
import { cancellationOptions, tripEvents, trips } from "../../schema";
import {
  canTransition,
  cancelTripSchema,
  type CancelTripInput,
  type TripStatus,
} from "@brazil-tms/shared";
import { writeAudit } from "../audit/write-audit";
import { Conflict } from "../errors";
import { recomputeTripSla } from "./sla";
import { loadTripDetail, type TripDetail } from "./trip-dto";

/**
 * Cancel a trip (US4; R8, FR-019..FR-022). The five required inputs are enforced by parsing the
 * submitted body with `cancelTripSchema` — a missing required field (e.g. `responsibleParty`) throws
 * a `ZodError` that the route layer maps to 400, so the "five required inputs" rule lives in one
 * place and cannot be bypassed by calling the service directly.
 *
 * `reasonCode` and `billingImpact` are NOT enums; they are validated against the ACTIVE rows in the
 * config-driven `cancellation_options` table (data-model §3, Constitution V). When the required
 * `kind` has no active rows, cancellation FAILS with `CANCELLATION_NOT_CONFIGURED`
 * ("missing configuration → fail", FR-021) — business must supply codes before any trip can cancel.
 *
 * The cancellable check (`canTransition(..., "cancelled")`) runs BEFORE the transaction so a denied
 * cancel changes no state (SC-003). The single transaction writes the guarded `trips` update, the
 * append-only `status_change` event, and the audit row together so a cancellation is never unlogged.
 *
 * 017 (exposure slice): `opts.allowedSourceStatuses` narrows WHICH source statuses the caller may
 * cancel from — the PRD §18 Dispatcher-"Limited" rule (the BFF passes `DISPATCH_PHASE_TRIP_STATUSES`
 * for dispatchers; admins/ops managers pass nothing). Checked against the loaded row, and race-safe:
 * the optimistic `WHERE current_status = <checked>` update means the status that passed the check is
 * the status at write time (a concurrent advance yields `STALE_TRANSITION`, never a bypass).
 */
export async function cancelTrip(
  tripId: string,
  input: CancelTripInput,
  actorUserId: string,
  opts: { allowedSourceStatuses?: readonly TripStatus[] } = {},
): Promise<TripDetail> {
  // Enforces the five required inputs; a missing field throws ZodError → 400.
  const parsed = cancelTripSchema.parse(input);

  // Config-driven value sets — both `kind`s must be configured (FR-021).
  const options = await db
    .select({ kind: cancellationOptions.kind, code: cancellationOptions.code })
    .from(cancellationOptions)
    .where(eq(cancellationOptions.active, true));
  const reasonCodes = new Set(options.filter((o) => o.kind === "reason").map((o) => o.code));
  const billingCodes = new Set(
    options.filter((o) => o.kind === "billing_impact").map((o) => o.code),
  );

  if (reasonCodes.size === 0 || billingCodes.size === 0) {
    throw new Conflict("CANCELLATION_NOT_CONFIGURED", "Motivos de cancelamento não configurados.");
  }
  if (!reasonCodes.has(parsed.reasonCode)) {
    throw new Conflict("INVALID_REASON_CODE", "Motivo de cancelamento inválido.");
  }
  if (!billingCodes.has(parsed.billingImpact)) {
    throw new Conflict("INVALID_BILLING_IMPACT", "Impacto de faturamento inválido.");
  }

  const currentRows = await db.select().from(trips).where(eq(trips.id, tripId)).limit(1);
  const row = currentRows[0];
  if (!row) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");

  // Role-scoped source-status limit (017 FR-007 — §18 Dispatcher "Limited"), before the generic
  // legality check so the caller gets the precise refusal reason.
  if (opts.allowedSourceStatuses && !opts.allowedSourceStatuses.includes(row.currentStatus)) {
    throw new Conflict(
      "NOT_CANCELLABLE_BY_ROLE",
      "Seu perfil só pode cancelar viagens na fase de expedição.",
    );
  }

  // Cancellable check BEFORE the transaction so a denied cancel changes no state (SC-003).
  if (!canTransition(row.currentStatus, "cancelled")) {
    throw new Conflict("NOT_CANCELLABLE", "A viagem não pode ser cancelada neste status.");
  }

  const cancelledAt = parsed.cancellationTimestamp ?? new Date();

  return db.transaction(async (tx) => {
    const now = new Date();
    // Status-guarded update: only succeeds if the trip is still in the status we checked (optimistic).
    const updated = await tx
      .update(trips)
      .set({
        currentStatus: "cancelled",
        cancellationReasonCode: parsed.reasonCode,
        cancellationResponsibleParty: parsed.responsibleParty,
        cancellationBillingImpact: parsed.billingImpact,
        cancelledAt,
        updatedAt: now,
      })
      .where(and(eq(trips.id, tripId), eq(trips.currentStatus, row.currentStatus)))
      .returning();
    if (updated.length === 0) {
      throw new Conflict("STALE_TRANSITION", "A viagem já mudou de status.");
    }

    await tx.insert(tripEvents).values({
      tripId,
      eventType: "status_change",
      statusBefore: row.currentStatus,
      statusAfter: "cancelled",
      // The milestone always carries the effective cancellation time (the caller's, or now() per R8),
      // never null — so a cancellation event is never timestamp-less.
      eventTimestamp: cancelledAt,
      source: "operator_manual",
      actorUserId,
    });

    await writeAudit(tx, {
      entityType: "trip",
      entityId: tripId,
      action: "trip.cancel",
      previousValue: { currentStatus: row.currentStatus },
      // Capture ALL of the cancellation inputs, incl. cancelledAt (data-model.md → Audit actions:
      // "trip.cancel = reason_code, responsible_party, billing_impact, cancelled_at").
      newValue: {
        currentStatus: "cancelled",
        cancellationReasonCode: parsed.reasonCode,
        cancellationResponsibleParty: parsed.responsibleParty,
        cancellationBillingImpact: parsed.billingImpact,
        cancelledAt: cancelledAt.toISOString(),
      },
      actorUserId,
    });

    // Cancelling is a TERMINAL transition, and the worker sweep only evaluates ACTIVE trips — so a
    // trip cancelled while At Risk/Late would keep its stale `sla_status`/`sla_reasons` + active alerts
    // forever. Recompute in-tx (the terminal branch of `recomputeTripSla` clears the risk state and
    // auto-resolves the trip's alerts) so the returned detail — and the board — reflect a clean close.
    // Mirrors the `completed` milestone path, which already recomputes via `transitionTripStatus`.
    await recomputeTripSla(tx, tripId);

    const detail = await loadTripDetail(tx, tripId);
    if (!detail) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");
    return detail;
  });
}

/** One row of the config-driven cancellation value sets, as served to the cancel dialog (017 R3). */
export interface CancellationOptionItem {
  kind: "reason" | "billing_impact";
  code: string;
  labelPt: string;
  sortOrder: number;
}

/**
 * ACTIVE cancellation options for the cancel dialog (017 R3; FR-004), ordered `kind, sort_order`.
 * Serves `GET /api/cancellation-options` — NOT `/api/reason-codes`, which is the 007 EXCEPTION
 * reason-code table (a different domain kept deliberately separate). Bounded config list, no paging.
 */
export async function queryCancellationOptions(): Promise<CancellationOptionItem[]> {
  const rows = await db
    .select({
      kind: cancellationOptions.kind,
      code: cancellationOptions.code,
      labelPt: cancellationOptions.labelPt,
      sortOrder: cancellationOptions.sortOrder,
    })
    .from(cancellationOptions)
    .where(eq(cancellationOptions.active, true))
    .orderBy(asc(cancellationOptions.kind), asc(cancellationOptions.sortOrder));
  return rows.map((r) => ({ ...r, kind: r.kind as CancellationOptionItem["kind"] }));
}
