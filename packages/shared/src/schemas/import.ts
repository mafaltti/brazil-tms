import { z } from "zod";

/**
 * Feature 004 import config schemas — the SINGLE validation boundary for the config-driven
 * import engine (contracts/import-engine-api.md §B). These shapes are the contract: the web
 * admin UI persists/validates template config against them and the worker reads them back the
 * same way, so there is ONE engine and NO per-customer code (Constitution V).
 *
 * Customer variation (column names, date/number formats, required fields) is DATA validated by
 * these schemas, never branching code. Engine internals (normalize/engine/matching) are English;
 * the trip-domain Zod schemas (`./trip`) keep their pt-BR boundary messages — these config schemas
 * are admin-only plumbing, so English messages are fine.
 */

// ---------------------------------------------------------------------------
// parsingRules — how raw cell strings become typed values (consumed by ./import/normalize)
// ---------------------------------------------------------------------------

export const parsingRulesSchema = z
  .object({
    dateFormats: z.array(z.string()).default([]),
    timezone: z.string().default("America/Sao_Paulo"),
    decimalSeparator: z.string().default(","),
    thousandSeparator: z.string().default("."),
  })
  .default({});

export type ParsingRules = z.infer<typeof parsingRulesSchema>;

// ---------------------------------------------------------------------------
// columnMapping — one source-column → internal-target mapping
// ---------------------------------------------------------------------------

export const columnMappingSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  required: z.boolean().optional(),
});

export type ColumnMapping = z.infer<typeof columnMappingSchema>;

// ---------------------------------------------------------------------------
// templateConfig — the per-customer import template (data, not code)
// ---------------------------------------------------------------------------

export const templateConfigSchema = z.object({
  customerId: z.string().uuid(),
  name: z.string().min(1),
  version: z.number().int().min(1),
  fileType: z.enum(["csv", "xlsx"]),
  columnMappings: z.array(columnMappingSchema).min(1),
  parsingRules: parsingRulesSchema,
  requiredOverrides: z.array(z.string()).default([]),
});

export type TemplateConfig = z.infer<typeof templateConfigSchema>;

// ---------------------------------------------------------------------------
// uploadMeta — the metadata accompanying an uploaded import file
// ---------------------------------------------------------------------------

export const uploadMetaSchema = z.object({
  customerId: z.string().uuid(),
  templateId: z.string().uuid().optional(),
  fileName: z.string().min(1),
  fileType: z.enum(["csv", "xlsx"]),
});

export type UploadMeta = z.infer<typeof uploadMetaSchema>;

// ---------------------------------------------------------------------------
// MappedRow — the subset of internal trip fields the engine produces from one raw row
// (a structural subset of 003 createTripSchema; externalTripId may be null, every field nullable)
// ---------------------------------------------------------------------------

export interface MappedRow {
  externalTripId: string | null;
  originCode: string | null;
  destinationCode: string | null;
  statusLabel: string | null;
  plannedPickupWindowStart: Date | null;
  plannedPickupWindowEnd: Date | null;
  plannedDeliveryWindowStart: Date | null;
  plannedDeliveryWindowEnd: Date | null;
  plannedVehicleType: string | null;
  plannedVolumeUnits: number | null;
  plannedWeightKg: number | null;
  plannedPalletCount: number | null;
  plannedDistanceKm: number | null;
  plannedTransitTimeMinutes: number | null;
  plannedRouteNotes: string | null;
  plannedServiceRequirements: Record<string, unknown> | null;
}

/**
 * Recognized target field names by kind — the SINGLE source of truth shared by the engine and the
 * tests so a new field is added in exactly one place. The engine uses these to decide how to coerce
 * each mapped cell (date → Luxon, number → separators, json → JSON.parse, string → trimmed text).
 */
export const MAPPED_DATE_FIELDS = [
  "plannedPickupWindowStart",
  "plannedPickupWindowEnd",
  "plannedDeliveryWindowStart",
  "plannedDeliveryWindowEnd",
] as const;

export const MAPPED_NUMBER_FIELDS = [
  "plannedVolumeUnits",
  "plannedWeightKg",
  "plannedPalletCount",
  "plannedDistanceKm",
  "plannedTransitTimeMinutes",
] as const;

export const MAPPED_STRING_FIELDS = [
  "externalTripId",
  "originCode",
  "destinationCode",
  "statusLabel",
  "plannedVehicleType",
  "plannedRouteNotes",
] as const;

export const MAPPED_JSON_FIELDS = ["plannedServiceRequirements"] as const;
