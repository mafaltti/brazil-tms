import { DateTime } from "luxon";
import type { MappedRow } from "../schemas/import";

/**
 * Pure matching helpers for duplicate detection (contracts/import-engine-api.md §B; data-model
 * `import.detect-duplicates`). Primary matching is the EXACT `(customer, external_trip_id)` key and
 * lives in the worker job (it needs the DB); these helpers cover the two pure pieces: the
 * fuzzy look-alike key and the in-file collision scan.
 */

/**
 * Build a fuzzy "look-alike" key for ID-less / potential-duplicate detection.
 *
 * DOCUMENTED-DEFAULT tolerance — the real fuzzy-duplicate tolerance is a PRD §29 business input
 * that remains BLOCKED, so this is a labeled scaffolded default, NOT an invented rule: bucket the
 * pickup window to its calendar DATE (yyyy-MM-dd in UTC) and case-/whitespace-normalize origin,
 * destination and vehicle type. Tighten/loosen this once the tolerance is confirmed.
 *
 * The customer id is NOT part of the key: it is constant per batch, so the detect-duplicates job
 * scopes the fuzzy lookup to the batch's customer when it compares keys.
 */
export function buildFuzzyKey(
  row: Pick<
    MappedRow,
    "originCode" | "destinationCode" | "plannedPickupWindowStart" | "plannedVehicleType"
  >,
): string {
  const pickupDay =
    row.plannedPickupWindowStart == null
      ? ""
      : DateTime.fromJSDate(row.plannedPickupWindowStart).toUTC().toFormat("yyyy-MM-dd");

  return [row.originCode, row.destinationCode, pickupDay, row.plannedVehicleType]
    .map((x) => (x ?? "").toString().trim().toLowerCase())
    .join("|");
}

/**
 * Find rows that collide on a non-empty `externalTripId` with at least one OTHER row in the same
 * file (case-insensitive exact match). The detect-duplicates job marks every colliding row `error`
 * (an ambiguous in-file duplicate). Rows with a null/empty id never collide.
 */
export function detectInFileCollisions(
  rows: ReadonlyArray<{ rowNumber: number; externalTripId: string | null }>,
): Set<number> {
  // Group row numbers by normalized id, skipping blanks.
  const byId = new Map<string, number[]>();
  for (const { rowNumber, externalTripId } of rows) {
    const id = externalTripId?.trim().toLowerCase();
    if (!id) continue;
    const bucket = byId.get(id);
    if (bucket) bucket.push(rowNumber);
    else byId.set(id, [rowNumber]);
  }

  const colliding = new Set<number>();
  for (const bucket of byId.values()) {
    if (bucket.length > 1) {
      for (const rowNumber of bucket) colliding.add(rowNumber);
    }
  }
  return colliding;
}
