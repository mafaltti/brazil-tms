import type { PgBoss } from "pg-boss";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  customers,
  db,
  importBatches,
  importRows,
  importTemplates,
  locationAliases,
  locations,
  statusMappings,
} from "@brazil-tms/db";
import {
  VEHICLE_TYPE_VALUES,
  type MappedRow,
  type ValidatePayload,
} from "@brazil-tms/shared";
import { setBatchStatus } from "../../lib/batch-progress";
import { JOB, enqueue, work } from "../../lib/queue";

/**
 * T031 — `import.validate` job (data-model "Validation rules"; contract §C; spec FR-012). Per row,
 * compute `outcome` ∈ {valid, warning, error} + structured pt-BR `reasons`, and ENRICH `mapped` with
 * resolved location ids so the confirm stage can build a trip without re-resolving. Locations resolve
 * by the `(customer_id, code)` master-data key first, then (US4/T048) fall back to a remembered
 * `location_aliases` row keyed on `(customer_id, file_value)` so a previously-mapped unknown location
 * auto-resolves. Import NEVER creates master-data locations (slice 002 owns that — R11).
 * Duplicate/match detection is the NEXT stage (this job never sets `match_decision`).
 *
 * DOCUMENTED-DEFAULT bounds: the distance/transit plausibility check is a WARNING-only heuristic with
 * scaffolded bounds (PRD §29 — BLOCKED). It is never an error gate; loosen/tighten once Ops confirms.
 */

interface Reason {
  code: string;
  field?: string;
  message: string;
}

type Outcome = "valid" | "warning" | "error";

/** Documented-default plausibility ceilings (BLOCKED on real files — warning only, never an error). */
const MAX_PLAUSIBLE_DISTANCE_KM = 5000;
const MAX_PLAUSIBLE_TRANSIT_MINUTES = 14 * 24 * 60; // 14 days

/** Internal trip fields that may be forced required per template (`requiredOverrides`). */
const REQUIRABLE_FIELDS = new Set<keyof MappedRow>([
  "externalTripId",
  "originCode",
  "destinationCode",
  "plannedPickupWindowStart",
  "plannedPickupWindowEnd",
  "plannedDeliveryWindowStart",
  "plannedDeliveryWindowEnd",
  "plannedVehicleType",
  "plannedVolumeUnits",
  "plannedWeightKg",
  "plannedPalletCount",
  "plannedRouteNotes",
]);

/** Case-insensitive normalized lookup of the `vehicle_type` enum members. */
const VEHICLE_TYPE_BY_LOWER = new Map<string, string>(
  VEHICLE_TYPE_VALUES.map((v) => [v.toLowerCase(), v]),
);

/** Parse a jsonb date field (ISO string after round-trip) back to a Date; null when absent/invalid. */
function toDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function isBlank(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim() === "");
}

interface ValidationResult {
  outcome: Outcome;
  reasons: Reason[];
  mapped: Record<string, unknown> | null;
}

/**
 * Validate one staged row against the batch's customer + resolved locations. Returns the verdict and
 * the enriched `mapped` (with `originLocationId`/`destinationLocationId` and the normalized vehicle
 * type written back). `mapped === null` from parse (mapping error) short-circuits to `error`.
 */
async function validateRow(
  customerId: string,
  rawMapped: Record<string, unknown> | null,
  requiredOverrides: string[],
  knownStatusLabels: Set<string>,
): Promise<ValidationResult> {
  if (rawMapped == null) {
    return {
      outcome: "error",
      reasons: [{ code: "MAPPING_ERROR", message: "Não foi possível interpretar a linha." }],
      mapped: null,
    };
  }

  const mapped: Record<string, unknown> = { ...rawMapped };
  const reasons: Reason[] = [];

  // external_trip_id present
  const externalTripId = mapped.externalTripId;
  if (isBlank(externalTripId)) {
    reasons.push({
      code: "MISSING_EXTERNAL_ID",
      field: "externalTripId",
      message: "O identificador externo da viagem é obrigatório.",
    });
  }

  // Resolve origin/destination by (customer, code) against active master-data locations.
  const originCode = mapped.originCode;
  let originLocationId: string | null = null;
  if (isBlank(originCode)) {
    reasons.push({
      code: "UNKNOWN_LOCATION",
      field: "originCode",
      message: "Local de origem não informado.",
    });
  } else {
    originLocationId = await resolveLocation(customerId, String(originCode));
    if (originLocationId == null) {
      reasons.push({
        code: "UNKNOWN_LOCATION",
        field: "originCode",
        message: `Local de origem desconhecido: ${String(originCode)}.`,
      });
    } else {
      mapped.originLocationId = originLocationId;
    }
  }

  const destinationCode = mapped.destinationCode;
  let destinationLocationId: string | null = null;
  if (isBlank(destinationCode)) {
    reasons.push({
      code: "UNKNOWN_LOCATION",
      field: "destinationCode",
      message: "Local de destino não informado.",
    });
  } else {
    destinationLocationId = await resolveLocation(customerId, String(destinationCode));
    if (destinationLocationId == null) {
      reasons.push({
        code: "UNKNOWN_LOCATION",
        field: "destinationCode",
        message: `Local de destino desconhecido: ${String(destinationCode)}.`,
      });
    } else {
      mapped.destinationLocationId = destinationLocationId;
    }
  }

  // origin != destination (by resolved id)
  if (
    originLocationId != null &&
    destinationLocationId != null &&
    originLocationId === destinationLocationId
  ) {
    reasons.push({
      code: "SAME_ORIGIN_DESTINATION",
      field: "destinationCode",
      message: "Origem e destino devem ser diferentes.",
    });
  }

  // pickup/delivery windows: when both ends present, start <= end.
  checkWindow(
    toDate(mapped.plannedPickupWindowStart),
    toDate(mapped.plannedPickupWindowEnd),
    "plannedPickupWindowStart",
    "Janela de coleta inválida: início posterior ao fim.",
    reasons,
  );
  checkWindow(
    toDate(mapped.plannedDeliveryWindowStart),
    toDate(mapped.plannedDeliveryWindowEnd),
    "plannedDeliveryWindowStart",
    "Janela de entrega inválida: início posterior ao fim.",
    reasons,
  );

  // vehicle type: case-insensitive map to the fixed enum; unmappable = warning (never blocks).
  const vehicleRaw = mapped.plannedVehicleType;
  if (!isBlank(vehicleRaw)) {
    const matched = VEHICLE_TYPE_BY_LOWER.get(String(vehicleRaw).trim().toLowerCase());
    if (matched) {
      mapped.plannedVehicleType = matched;
    } else {
      reasons.push({
        code: "UNMAPPABLE_VEHICLE_TYPE",
        field: "plannedVehicleType",
        message: `Tipo de veículo não reconhecido: ${String(vehicleRaw)}.`,
      });
      // Drop the unmappable value so the trip insert (enum column) does not fail on confirm.
      mapped.plannedVehicleType = null;
    }
  }

  // status label: the file's status is RECORDED only — import never uses it to transition a trip
  // (R10). The file's status label does NOT drive the trip's status: newly created trips are born
  // `received` (slice 015), independent of this label. An unknown customer label is flagged as a
  // WARNING (never guessed,
  // never blocks): the customer's status vocabulary is config (`status_mappings`), BLOCKED on real
  // files (PRD §29), so an unmapped label is surfaced for an operator to map rather than silently kept.
  const statusLabel = mapped.statusLabel;
  if (!isBlank(statusLabel) && !knownStatusLabels.has(String(statusLabel).trim().toLowerCase())) {
    reasons.push({
      code: "UNMAPPED_STATUS",
      field: "statusLabel",
      message: `Status do cliente sem mapeamento: ${String(statusLabel)}.`,
    });
  }

  // required fields (template.requiredOverrides) must be non-null in mapped.
  for (const field of requiredOverrides) {
    if (!REQUIRABLE_FIELDS.has(field as keyof MappedRow)) continue;
    if (isBlank(mapped[field])) {
      reasons.push({
        code: "MISSING_REQUIRED_FIELD",
        field,
        message: `Campo obrigatório ausente: ${field}.`,
      });
    }
  }

  // distance / transit plausibility — WARNING-level documented-default heuristic (BLOCKED bounds).
  const distance = mapped.plannedDistanceKm;
  if (typeof distance === "number" && distance > MAX_PLAUSIBLE_DISTANCE_KM) {
    reasons.push({
      code: "IMPLAUSIBLE_DISTANCE",
      field: "plannedDistanceKm",
      message: `Distância pouco plausível (> ${MAX_PLAUSIBLE_DISTANCE_KM} km).`,
    });
  }
  const transit = mapped.plannedTransitTimeMinutes;
  if (typeof transit === "number" && transit > MAX_PLAUSIBLE_TRANSIT_MINUTES) {
    reasons.push({
      code: "IMPLAUSIBLE_TRANSIT",
      field: "plannedTransitTimeMinutes",
      message: "Tempo de trânsito pouco plausível.",
    });
  }

  const errorCodes = new Set([
    "MISSING_EXTERNAL_ID",
    "UNKNOWN_LOCATION",
    "SAME_ORIGIN_DESTINATION",
    "INVALID_WINDOW",
    "MISSING_REQUIRED_FIELD",
    "MAPPING_ERROR",
  ]);
  const hasError = reasons.some((r) => errorCodes.has(r.code));
  const outcome: Outcome = hasError ? "error" : reasons.length > 0 ? "warning" : "valid";

  return { outcome, reasons, mapped };
}

function checkWindow(
  start: Date | null,
  end: Date | null,
  field: string,
  message: string,
  reasons: Reason[],
): void {
  if (start != null && end != null && start.getTime() > end.getTime()) {
    reasons.push({ code: "INVALID_WINDOW", field, message });
  }
}

/**
 * Resolve a location for a customer (R11). First the `(customer_id, code)` master-data key among active
 * (non-archived) sites; on a miss, a remembered `location_aliases` row keyed on `(customer_id,
 * file_value)` that points at a STILL-ACTIVE location (T048). Returns null = `unknown_location`.
 */
async function resolveLocation(customerId: string, code: string): Promise<string | null> {
  const rows = await db
    .select({ id: locations.id })
    .from(locations)
    .where(
      and(
        eq(locations.customerId, customerId),
        eq(locations.code, code),
        isNull(locations.archivedAt),
      ),
    )
    .limit(1);
  if (rows[0]) return rows[0].id;

  // Alias fallback: a previously-mapped file value → an active location for this customer.
  const aliasRows = await db
    .select({ locationId: locationAliases.locationId })
    .from(locationAliases)
    .innerJoin(locations, eq(locations.id, locationAliases.locationId))
    .where(
      and(
        eq(locationAliases.customerId, customerId),
        eq(locationAliases.fileValue, code),
        isNull(locations.archivedAt),
      ),
    )
    .limit(1);
  return aliasRows[0]?.locationId ?? null;
}

export async function runValidate(payload: ValidatePayload): Promise<void> {
  const { batchId } = payload;
  await setBatchStatus(batchId, "validating");

  const batchRows = await db
    .select()
    .from(importBatches)
    .where(eq(importBatches.id, batchId))
    .limit(1);
  const batch = batchRows[0];
  if (!batch) return;

  const customerRows = await db
    .select({ id: customers.id, archivedAt: customers.archivedAt })
    .from(customers)
    .where(eq(customers.id, batch.customerId))
    .limit(1);
  const customerArchived = customerRows[0]?.archivedAt != null || customerRows.length === 0;

  // Template overrides for required fields (the batch may have no template — then none).
  const requiredOverrides = await loadRequiredOverrides(batch.templateId);

  // The customer's configured status vocabulary (active mappings) — used to flag unmapped labels (R10).
  const knownStatusLabels = await loadStatusLabels(batch.customerId);

  const rows = await db
    .select()
    .from(importRows)
    .where(eq(importRows.importBatchId, batchId))
    .orderBy(asc(importRows.rowNumber));

  for (const row of rows) {
    if (customerArchived) {
      await db
        .update(importRows)
        .set({
          outcome: "error",
          reasons: [
            { code: "INACTIVE_CUSTOMER", message: "O cliente da importação não está ativo." },
          ],
        })
        .where(eq(importRows.id, row.id));
      continue;
    }

    const result = await validateRow(
      batch.customerId,
      row.mapped as Record<string, unknown> | null,
      requiredOverrides,
      knownStatusLabels,
    );

    await db
      .update(importRows)
      .set({
        outcome: result.outcome,
        reasons: result.reasons,
        mapped: result.mapped as object | null,
      })
      .where(eq(importRows.id, row.id));
  }
}

/** Active status-label vocabulary for the customer, normalized (trim/lowercase) for matching (R10). */
async function loadStatusLabels(customerId: string): Promise<Set<string>> {
  const rows = await db
    .select({ label: statusMappings.customerLabel })
    .from(statusMappings)
    .where(
      and(
        eq(statusMappings.customerId, customerId),
        eq(statusMappings.active, true),
        isNull(statusMappings.archivedAt),
      ),
    );
  return new Set(rows.map((r) => r.label.trim().toLowerCase()));
}

/** Read the template's `requiredOverrides` (string[]) for the batch, or [] when none. */
async function loadRequiredOverrides(templateId: string | null): Promise<string[]> {
  if (!templateId) return [];
  const rows = await db
    .select({ requiredOverrides: importTemplates.requiredOverrides })
    .from(importTemplates)
    .where(eq(importTemplates.id, templateId))
    .limit(1);
  const raw = rows[0]?.requiredOverrides;
  return Array.isArray(raw) ? (raw as string[]) : [];
}

export async function registerValidate(boss: PgBoss): Promise<void> {
  await work(boss, JOB.validate, async (payload) => {
    await runValidate(payload);
    await enqueue(boss, JOB.detectDuplicates, { batchId: payload.batchId });
  });
}
