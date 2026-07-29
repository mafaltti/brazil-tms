import { eq } from "drizzle-orm";
import { db } from "../client";
import { trips } from "../../schema";
import { TRIP_CRITICAL_FIELDS, TRIP_STATUSES, type TripPlanFields } from "@brazil-tms/shared";
import { writeAudit } from "../audit/write-audit";
import { Conflict } from "../errors";
import { loadTripDetail, type TripDetail } from "./trip-dto";

/**
 * Plan-update service (US1; FR-005, FR-016). Applies an accepted customer update to the live
 * `planned_*` columns — the CURRENT plan (R4/R5). The immutable `original_plan` snapshot is NEVER
 * touched here. A `trip.plan_update` audit row is written only when a CHANGED field is in the
 * documented critical-field set (R9, FR-016); a non-critical-only edit writes no audit. Edits after
 * `confirmed` require an authorized review (FR-005).
 */

/** The 10 live, updatable planned fields (mirrors `tripPlanFieldsSchema`; `original_plan` excluded). */
const PLAN_FIELDS = [
  "plannedPickupWindowStart",
  "plannedPickupWindowEnd",
  "plannedDeliveryWindowStart",
  "plannedDeliveryWindowEnd",
  "plannedVehicleType",
  "plannedVolumeUnits",
  "plannedWeightKg",
  "plannedPalletCount",
  "plannedRouteNotes",
  "plannedServiceRequirements",
] as const satisfies readonly (keyof TripPlanFields)[];

const CRITICAL = new Set<string>(TRIP_CRITICAL_FIELDS);

/** Strict-equal, treating two Dates with the same instant as equal (timestamps compare by value). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

export async function updateTripPlan(
  tripId: string,
  changes: TripPlanFields,
  args: { authorizedReview?: boolean },
  actorUserId: string,
): Promise<TripDetail> {
  return db.transaction(async (tx) => {
    // Lock the row for the transaction (R7): the review-gate check, the per-field diff, and the write
    // all evaluate against ONE consistent snapshot. A concurrent transition cannot move the trip past
    // `confirmed` — nor change a field under us — between the read and the update, so the post-confirmed
    // gate can't be bypassed and the audit's previous values can't be stale. (A row lock by PK is
    // chosen over an `updated_at` equality guard, which is fragile against timestamptz sub-ms precision.)
    const currentRows = await tx
      .select()
      .from(trips)
      .where(eq(trips.id, tripId))
      .for("update")
      .limit(1);
    const current = currentRows[0];
    if (!current) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");

    // Post-confirmed review gate (FR-005), re-checked against the LOCKED status.
    const pastConfirmed =
      TRIP_STATUSES.indexOf(current.currentStatus) > TRIP_STATUSES.indexOf("confirmed");
    if (pastConfirmed && !args.authorizedReview) {
      throw new Conflict(
        "REVIEW_REQUIRED",
        "Edições após a confirmação exigem revisão autorizada.",
      );
    }

    // Provided fields = the planned keys explicitly present (undefined = untouched; null = clear).
    const provided = PLAN_FIELDS.filter((field) => changes[field] !== undefined);

    const set: Record<string, unknown> = { updatedAt: new Date() };
    const previousValue: Record<string, unknown> = {};
    const newValue: Record<string, unknown> = {};
    const currentRow = current as Record<string, unknown>;

    for (const field of provided) {
      const next = changes[field] ?? null;
      set[field] = next;
      // A critical change = a provided critical field whose new value differs from the locked one.
      if (CRITICAL.has(field) && !sameValue(currentRow[field], next)) {
        previousValue[field] = currentRow[field] ?? null;
        newValue[field] = next;
      }
    }

    // Validate the MERGED plan window ordering: a partial edit must not leave the live plan with
    // start > end. The Zod boundary schema only rejects the case where BOTH bounds are in one
    // request; here each window's effective value (the provided value, else the locked current value)
    // is checked — so e.g. moving only the pickup END before the existing START is rejected. Done
    // under the row lock so a concurrent edit to the other bound can't slip a bad state through.
    const effectiveWindow = (field: keyof TripPlanFields): Date | null => {
      const value = changes[field] !== undefined ? changes[field] : currentRow[field];
      return value instanceof Date ? value : null;
    };
    const pickupStart = effectiveWindow("plannedPickupWindowStart");
    const pickupEnd = effectiveWindow("plannedPickupWindowEnd");
    if (pickupStart && pickupEnd && pickupStart.getTime() > pickupEnd.getTime()) {
      throw new Conflict(
        "INVALID_PLAN_WINDOW",
        "A janela de coleta é inválida: o início deve ser anterior ou igual ao fim.",
      );
    }
    const deliveryStart = effectiveWindow("plannedDeliveryWindowStart");
    const deliveryEnd = effectiveWindow("plannedDeliveryWindowEnd");
    if (deliveryStart && deliveryEnd && deliveryStart.getTime() > deliveryEnd.getTime()) {
      throw new Conflict(
        "INVALID_PLAN_WINDOW",
        "A janela de entrega é inválida: o início deve ser anterior ou igual ao fim.",
      );
    }

    const criticalChanged = Object.keys(newValue).length > 0;

    await tx.update(trips).set(set).where(eq(trips.id, tripId));

    if (criticalChanged) {
      await writeAudit(tx, {
        entityType: "trip",
        entityId: tripId,
        action: "trip.plan_update",
        previousValue,
        newValue,
        actorUserId,
      });
    }

    const detail = await loadTripDetail(tx, tripId);
    if (!detail) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");
    return detail;
  });
}
