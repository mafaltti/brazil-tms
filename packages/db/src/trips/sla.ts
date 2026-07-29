import { and, count, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  DEFAULT_SLA_POLICY,
  evaluateSlaRisk,
  isActiveStatus,
  type SlaContext,
  type SlaPolicy,
} from "@brazil-tms/shared";
import type { DB } from "../client";
import { alerts, customerSlaRules, exceptions, tripAssignments, tripEvents, trips } from "../../schema";

/**
 * Feature 007 — the single on-change SLA recompute (data-model §11.2, R11). Gathers the per-trip facts
 * the pure evaluator needs, resolves the applicable `customer_sla_rules` policy (precedence
 * lane > vehicle-type > customer-default, tie-break latest `effective_start`; else `DEFAULT_SLA_POLICY`),
 * calls `evaluateSlaRisk`, and writes `sla_status`/`sla_reasons` atomically. NOT separately audited
 * (a derived projection — the triggering mutation is already audited). Terminal/cancelled trips
 * short-circuit with NO write.
 *
 * Accepts either the live `db` or a transaction handle (`tx`) so every risk-affecting mutation can
 * recompute inside its own transaction (immediate UI truth), and the worker sweep can call it under a
 * `SELECT … FOR UPDATE` row lock.
 */

/** Anything that can `select` + `update` — the live `db` or a `tx`. */
type SlaExecutor = Pick<DB, "select" | "update">;

/** Map a `customer_sla_rules` row to the evaluator policy (time-in-status has no column → default). */
function toPolicy(rule: typeof customerSlaRules.$inferSelect): SlaPolicy {
  return {
    atRiskWarningMinutes: rule.atRiskWarningMinutes,
    pickupToleranceMinutes: rule.pickupToleranceMinutes,
    deliveryToleranceMinutes: rule.deliveryToleranceMinutes,
    confirmationCutoffMinutes: rule.confirmationCutoffMinutes,
    timeInStatusThresholdMinutes: DEFAULT_SLA_POLICY.timeInStatusThresholdMinutes,
  };
}

/**
 * Resolve the applicable SLA policy for a trip (data-model §4). The most-specific active rule whose
 * effective window covers the reference instant wins (lane > vehicle-type > customer-default, latest
 * `effective_start`); absent any match, the company `DEFAULT_SLA_POLICY` (and the customer's SLA
 * sign-off is reported blocked — FR-022).
 */
export async function resolveSlaPolicy(
  ex: SlaExecutor,
  args: {
    customerId: string;
    laneId: string | null;
    vehicleType: string | null;
    referenceTime: Date;
  },
): Promise<{ policy: SlaPolicy; ruleId: string | null }> {
  const ref = args.referenceTime;
  const rows = await ex
    .select()
    .from(customerSlaRules)
    .where(
      and(
        eq(customerSlaRules.customerId, args.customerId),
        eq(customerSlaRules.active, true),
        or(
          isNull(customerSlaRules.laneId),
          args.laneId ? eq(customerSlaRules.laneId, args.laneId) : undefined,
        ),
        or(
          isNull(customerSlaRules.vehicleType),
          args.vehicleType
            ? eq(customerSlaRules.vehicleType, args.vehicleType as never)
            : undefined,
        ),
        or(isNull(customerSlaRules.effectiveStart), lte(customerSlaRules.effectiveStart, ref)),
        or(isNull(customerSlaRules.effectiveEnd), gte(customerSlaRules.effectiveEnd, ref)),
      ),
    )
    // Precedence (data-model §4): lane-scoped > vehicle-type-scoped > customer-default; tie-break
    // latest effective_start. Order by the PRESENCE of each scope (a non-null lane/vehicle-type ranks
    // higher) — NOT by the id value, since `DESC` on a uuid/enum puts NULLs first and would invert it.
    .orderBy(
      sql`(${customerSlaRules.laneId} is not null) desc`,
      sql`(${customerSlaRules.vehicleType} is not null) desc`,
      sql`${customerSlaRules.effectiveStart} desc nulls last`,
    )
    .limit(1);

  const rule = rows[0];
  return rule ? { policy: toPolicy(rule), ruleId: rule.id } : { policy: DEFAULT_SLA_POLICY, ruleId: null };
}

/**
 * Recompute and persist a trip's SLA risk. Loads planned windows + current status + the latest
 * status-entry time + 006 assignment/confirmation + open high-severity exception count, resolves the
 * policy, evaluates, and writes `sla_status`/`sla_reasons` atomically. Terminal/cancelled trips
 * short-circuit (no write). Recompute is a derived projection — NOT separately audited, so no actor
 * is taken (the triggering mutation carries the audit).
 */
export async function recomputeTripSla(ex: SlaExecutor, tripId: string): Promise<void> {
  const tripRows = await ex
    .select({
      customerId: trips.customerId,
      laneId: trips.laneId,
      currentStatus: trips.currentStatus,
      plannedVehicleType: trips.plannedVehicleType,
      plannedPickupWindowStart: trips.plannedPickupWindowStart,
      plannedPickupWindowEnd: trips.plannedPickupWindowEnd,
      plannedDeliveryWindowStart: trips.plannedDeliveryWindowStart,
      plannedDeliveryWindowEnd: trips.plannedDeliveryWindowEnd,
    })
    .from(trips)
    .where(eq(trips.id, tripId))
    .limit(1);
  const trip = tripRows[0];
  if (!trip) return;

  // Terminal/cancelled trips are not evaluated. They are ALSO skipped by the worker sweep, so a trip
  // that was At Risk/Late when it closed must be cleared HERE — otherwise its stale risk + any active
  // alerts would linger forever. Clear `sla_status`/`sla_reasons` and auto-resolve every not-yet-cleared
  // alert for the trip (all cases), then stop. (Done inline rather than via `autoResolveAlert`, whose
  // executor type requires `insert`; this executor is select+update only.)
  if (!isActiveStatus(trip.currentStatus)) {
    const closedAt = new Date();
    await ex
      .update(trips)
      .set({ slaStatus: null, slaReasons: null, updatedAt: closedAt })
      .where(eq(trips.id, tripId));
    await ex
      .update(alerts)
      .set({ state: "resolved", autoResolvedAt: closedAt, updatedAt: closedAt })
      .where(and(eq(alerts.tripId, tripId), inArray(alerts.state, ["active", "acknowledged"])));
    return;
  }

  const now = new Date();

  // The current assignment (006, read-only): presence + confirmed_at.
  const asgRows = await ex
    .select({ confirmedAt: tripAssignments.confirmedAt })
    .from(tripAssignments)
    .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.isCurrent, true)))
    .limit(1);
  const assignmentPresent = asgRows.length > 0;
  const confirmedAt = asgRows[0]?.confirmedAt ?? null;

  // When the trip entered its current status (time-in-status leg): latest status_change to it.
  const enteredRows = await ex
    .select({ createdAt: tripEvents.createdAt, eventTimestamp: tripEvents.eventTimestamp })
    .from(tripEvents)
    .where(and(eq(tripEvents.tripId, tripId), eq(tripEvents.statusAfter, trip.currentStatus)))
    .orderBy(desc(tripEvents.createdAt))
    .limit(1);
  const currentStatusEnteredAt = enteredRows[0]
    ? (enteredRows[0].eventTimestamp ?? enteredRows[0].createdAt)
    : null;

  // Open/monitoring high-severity exceptions on this trip (the FR-012 trigger).
  const hiRows = await ex
    .select({ value: count() })
    .from(exceptions)
    .where(
      and(
        eq(exceptions.tripId, tripId),
        inArray(exceptions.status, ["open", "monitoring"]),
        eq(exceptions.severity, "high"),
      ),
    );
  const openHighSeverityExceptionCount = hiRows[0]?.value ?? 0;

  const { policy } = await resolveSlaPolicy(ex, {
    customerId: trip.customerId,
    laneId: trip.laneId,
    vehicleType: trip.plannedVehicleType,
    referenceTime: trip.plannedPickupWindowStart ?? now,
  });

  const ctx: SlaContext = {
    now,
    currentStatus: trip.currentStatus,
    plannedPickupWindowStart: trip.plannedPickupWindowStart,
    plannedPickupWindowEnd: trip.plannedPickupWindowEnd,
    plannedDeliveryWindowStart: trip.plannedDeliveryWindowStart,
    plannedDeliveryWindowEnd: trip.plannedDeliveryWindowEnd,
    confirmedAt,
    assignmentPresent,
    openHighSeverityExceptionCount,
    currentStatusEnteredAt,
  };

  const { status, reasons } = evaluateSlaRisk(ctx, policy);

  await ex
    .update(trips)
    .set({ slaStatus: status, slaReasons: reasons, updatedAt: now })
    .where(eq(trips.id, tripId));
}
