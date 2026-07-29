import type { PgBoss } from "pg-boss";
import { and, asc, eq } from "drizzle-orm";
import { db, importBatches, importRows, trips } from "@brazil-tms/db";
import { buildFuzzyKey, detectInFileCollisions } from "@brazil-tms/shared";
import type { DetectDuplicatesPayload } from "@brazil-tms/shared";
import { setBatchCounts, setBatchStatus } from "../../lib/batch-progress";
import { JOB, enqueue, work } from "../../lib/queue";

/**
 * T032/T045 — `import.detect-duplicates` job (data-model R7; contract §C). For each non-error row, key
 * on `(customer_id, external_trip_id)` against existing `trips`:
 *   - no match            → `new`
 *   - match, plan differs  → `update`
 *   - match, identical     → `no_op`
 * A repeated external id is NEVER a blocking duplicate (FR-021). Error rows get `unresolved`.
 *
 * US3 (T045) adds two pure passes around the per-row exact match:
 *   - IN-FILE COLLISION (FR-017a): ≥2 rows in the SAME batch sharing `(customer, external_trip_id)` are
 *     ALL `error` (`reasons: IN_FILE_COLLISION`, `match_decision = unresolved`) — created by NONE. Done
 *     BEFORE the per-row match so collided rows are excluded from new/update.
 *   - FUZZY POTENTIAL DUPLICATE (FR-022/FR-023): a row that would be `new` (no external-id match) whose
 *     `buildFuzzyKey` matches an existing trip of the SAME customer is downgraded to
 *     `match_decision = potential_duplicate`, `outcome = warning`, `reasons: POTENTIAL_DUPLICATE`. It is
 *     still applied on confirm, but only with the recorded reason on the row.
 *
 * The "differs" comparison is a documented SHALLOW compare of the planned fields the confirm stage
 * would pass to `updateTripPlan` (windows, vehicle type, counts, route notes) — value-equal by
 * instant for timestamps, strict-equal otherwise. JSON service-requirements are compared structurally.
 */

/** The planned fields confirm would write — the diff surface for new/update/no_op. */
const PLAN_COMPARE_FIELDS = [
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
] as const;

type TripRow = typeof trips.$inferSelect;

interface Reason {
  code: string;
  field?: string;
  message: string;
}

function toMillis(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const t = new Date(value).getTime();
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** A jsonb date field (ISO string after round-trip) back to a Date; null when absent/invalid. */
function toDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

const DATE_FIELDS = new Set<string>([
  "plannedPickupWindowStart",
  "plannedPickupWindowEnd",
  "plannedDeliveryWindowStart",
  "plannedDeliveryWindowEnd",
]);

/** True when the mapped row's planned value for `field` differs from the trip's current value. */
function fieldDiffers(field: string, mapped: Record<string, unknown>, trip: TripRow): boolean {
  const mappedValue = mapped[field] ?? null;
  const tripValue = (trip as unknown as Record<string, unknown>)[field] ?? null;

  if (DATE_FIELDS.has(field)) {
    return toMillis(mappedValue) !== toMillis(tripValue);
  }
  if (field === "plannedServiceRequirements") {
    return JSON.stringify(mappedValue) !== JSON.stringify(tripValue);
  }
  return mappedValue !== tripValue;
}

/**
 * Fuzzy key for a MAPPED import row (FR-022). `buildFuzzyKey` keys on origin/destination + pickup DAY +
 * vehicle type with the SHARED documented-default tolerance (PRD §29 — BLOCKED final values; the
 * tolerance lives inside `buildFuzzyKey`, never invented here). To make the import row and an existing
 * trip comparable we feed BOTH sides the RESOLVED location ids (validate enriched the mapped row with
 * `originLocationId`/`destinationLocationId`; the trip stores them natively) in the code slots — file
 * codes are not present on the persisted trip, but the resolved ids are the same notion on both sides.
 */
function fuzzyKeyForMappedRow(mapped: Record<string, unknown>): string | null {
  const originLocationId = mapped.originLocationId;
  const destinationLocationId = mapped.destinationLocationId;
  if (originLocationId == null || destinationLocationId == null) return null;
  return buildFuzzyKey({
    originCode: String(originLocationId),
    destinationCode: String(destinationLocationId),
    plannedPickupWindowStart: toDate(mapped.plannedPickupWindowStart),
    plannedVehicleType: (mapped.plannedVehicleType as string | null) ?? null,
  });
}

/** Fuzzy key for an existing trip, built the SAME way (resolved ids in the code slots). */
function fuzzyKeyForTrip(trip: TripRow): string {
  return buildFuzzyKey({
    originCode: trip.originLocationId,
    destinationCode: trip.destinationLocationId,
    plannedPickupWindowStart: trip.plannedPickupWindowStart,
    plannedVehicleType: trip.plannedVehicleType,
  });
}

export async function runDetectDuplicates(payload: DetectDuplicatesPayload): Promise<void> {
  const { batchId } = payload;

  const batchRows = await db
    .select()
    .from(importBatches)
    .where(eq(importBatches.id, batchId))
    .limit(1);
  const batch = batchRows[0];
  if (!batch) return;

  const rows = await db
    .select()
    .from(importRows)
    .where(eq(importRows.importBatchId, batchId))
    .orderBy(asc(importRows.rowNumber));

  // IN-FILE COLLISION pass (FR-017a): scan the WHOLE batch for rows that share a non-empty external id
  // with another row. Every colliding row is forced to `error`/`unresolved` so it is created by none.
  const collisions = detectInFileCollisions(
    rows.map((r) => {
      const mapped = (r.mapped ?? {}) as Record<string, unknown>;
      const ext = mapped.externalTripId;
      return {
        rowNumber: r.rowNumber,
        externalTripId: ext == null ? null : String(ext),
      };
    }),
  );

  // Existing trips of the SAME customer, for the fuzzy look-alike comparison (built once, in memory).
  const existingTrips = await db
    .select()
    .from(trips)
    .where(eq(trips.customerId, batch.customerId));
  const existingFuzzyKeys = new Set(existingTrips.map(fuzzyKeyForTrip));

  let createdCount = 0;
  let updatedCount = 0;
  let duplicateCount = 0;
  let errorCount = 0;

  for (const row of rows) {
    // In-file collision wins: mark error + unresolved BEFORE any exact/fuzzy match (excluded from apply).
    if (collisions.has(row.rowNumber)) {
      const existingReasons = Array.isArray(row.reasons) ? (row.reasons as Reason[]) : [];
      errorCount += 1;
      await db
        .update(importRows)
        .set({
          outcome: "error",
          matchDecision: "unresolved",
          reasons: [
            ...existingReasons,
            {
              code: "IN_FILE_COLLISION",
              field: "externalTripId",
              message:
                "Identificador externo duplicado dentro do mesmo arquivo: linha ambígua, não importada.",
            },
          ],
        })
        .where(eq(importRows.id, row.id));
      continue;
    }

    if (row.outcome === "error") {
      errorCount += 1;
      await db
        .update(importRows)
        .set({ matchDecision: "unresolved" })
        .where(eq(importRows.id, row.id));
      continue;
    }

    const mapped = (row.mapped ?? {}) as Record<string, unknown>;
    const externalTripId = mapped.externalTripId;

    let decision: "new" | "update" | "no_op" | "potential_duplicate";
    if (externalTripId == null || String(externalTripId).trim() === "") {
      // Should not reach here (validate flags missing id as error), but guard defensively.
      decision = "new";
    } else {
      const existing = await db
        .select()
        .from(trips)
        .where(
          and(
            eq(trips.customerId, batch.customerId),
            eq(trips.externalTripId, String(externalTripId)),
          ),
        )
        .limit(1);
      const trip = existing[0];
      if (!trip) {
        decision = "new";
      } else {
        const differs = PLAN_COMPARE_FIELDS.some((f) => fieldDiffers(f, mapped, trip));
        decision = differs ? "update" : "no_op";
      }
    }

    // FUZZY pass (FR-022): a would-be `new` row whose fuzzy key matches an existing trip of this
    // customer is a POTENTIAL duplicate (downgrade valid→warning; still applied with recorded reason).
    if (decision === "new") {
      const key = fuzzyKeyForMappedRow(mapped);
      if (key != null && existingFuzzyKeys.has(key)) {
        const existingReasons = Array.isArray(row.reasons) ? (row.reasons as Reason[]) : [];
        duplicateCount += 1;
        await db
          .update(importRows)
          .set({
            outcome: "warning",
            matchDecision: "potential_duplicate",
            reasons: [
              ...existingReasons,
              {
                code: "POTENTIAL_DUPLICATE",
                message:
                  "Possível duplicata: viagem semelhante já existe (mesma origem, destino, data de coleta e veículo).",
              },
            ],
          })
          .where(eq(importRows.id, row.id));
        continue;
      }
    }

    if (decision === "new") createdCount += 1;
    else if (decision === "update") updatedCount += 1;

    await db
      .update(importRows)
      .set({ matchDecision: decision })
      .where(eq(importRows.id, row.id));
  }

  await setBatchCounts(batchId, {
    createdCount,
    updatedCount,
    duplicateCount,
    errorCount,
  });
  await setBatchStatus(batchId, "validated");
}

export async function registerDetectDuplicates(boss: PgBoss): Promise<void> {
  await work(boss, JOB.detectDuplicates, async (payload) => {
    await runDetectDuplicates(payload);
    // US2 (T041): when the batch has error rows, enqueue the error-report job. Re-read the batch so the
    // freshly-tallied `error_count` (incl. in-file collisions) is reflected before deciding.
    const after = await db
      .select({ errorCount: importBatches.errorCount })
      .from(importBatches)
      .where(eq(importBatches.id, payload.batchId))
      .limit(1);
    if ((after[0]?.errorCount ?? 0) > 0) {
      await enqueue(boss, JOB.generateErrorReport, { batchId: payload.batchId });
    }
  });
}
