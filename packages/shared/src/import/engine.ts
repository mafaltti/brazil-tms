import type { TemplateConfig, MappedRow } from "../schemas/import";
import { MAPPED_DATE_FIELDS, MAPPED_NUMBER_FIELDS } from "../schemas/import";
import { normalizeDate, normalizeNumber } from "./normalize";

/**
 * The config-driven mapping engine (contracts/import-engine-api.md §B; Constitution V — ONE engine,
 * NO per-customer code). `applyTemplate` turns one raw row (source-header → cell string) into a
 * typed `MappedRow` by following the template's `columnMappings`, coercing each value by the
 * target's kind. Pure and deterministic — used identically by the web admin UI and the worker.
 */

const DATE_TARGETS = new Set<string>(MAPPED_DATE_FIELDS);
const NUMBER_TARGETS = new Set<string>(MAPPED_NUMBER_FIELDS);
const JSON_TARGETS = new Set<string>(["plannedServiceRequirements"]);

/** A fresh MappedRow with every recognized field null. */
function emptyMappedRow(): MappedRow {
  return {
    externalTripId: null,
    originCode: null,
    destinationCode: null,
    statusLabel: null,
    plannedPickupWindowStart: null,
    plannedPickupWindowEnd: null,
    plannedDeliveryWindowStart: null,
    plannedDeliveryWindowEnd: null,
    plannedVehicleType: null,
    plannedVolumeUnits: null,
    plannedWeightKg: null,
    plannedPalletCount: null,
    plannedDistanceKm: null,
    plannedTransitTimeMinutes: null,
    plannedRouteNotes: null,
    plannedServiceRequirements: null,
  };
}

/**
 * Map one raw row to a MappedRow using `template.columnMappings`.
 *
 * For each `{ source, target }`: an undefined or blank cell leaves the target null (skip).
 * Otherwise the trimmed value is coerced by target kind — date → `normalizeDate`, number →
 * `normalizeNumber`, json (plannedServiceRequirements) → `JSON.parse`, string/unrecognized →
 * the trimmed string. A normalization/parse failure THROWS so the caller (worker) can mark the
 * row `error`. Unrecognized targets are still stored under their key so custom config survives.
 */
export function applyTemplate(
  rawRow: Record<string, string>,
  template: TemplateConfig,
): MappedRow {
  // Typed accumulator: start from the recognized-field shape, but allow extra string keys for
  // custom targets that aren't part of MappedRow. Cast back to MappedRow at the end.
  const acc = emptyMappedRow() as unknown as Record<string, unknown>;

  for (const { source, target } of template.columnMappings) {
    const raw = rawRow[source];
    if (raw === undefined || String(raw).trim() === "") {
      continue; // leave the target null
    }
    const trimmed = String(raw).trim();

    if (DATE_TARGETS.has(target)) {
      acc[target] = normalizeDate(trimmed, template.parsingRules);
    } else if (NUMBER_TARGETS.has(target)) {
      acc[target] = normalizeNumber(trimmed, template.parsingRules);
    } else if (JSON_TARGETS.has(target)) {
      try {
        acc[target] = JSON.parse(trimmed);
      } catch {
        throw new Error(`UNPARSEABLE_JSON: ${target}`);
      }
    } else {
      // String target, or an unrecognized custom target: store the trimmed string.
      acc[target] = trimmed;
    }
  }

  return acc as unknown as MappedRow;
}
