import { z } from "zod";

/**
 * Feature 016 — GET /api/freight-rates query filters (contracts/freight-rates-api.md).
 * City values are exact strings originating from the dataset itself (combobox, R5);
 * price bounds are integer centavos over `valor_ida_cents`.
 */
export const freightRateFilterSchema = z.object({
  originUf: z.string().trim().length(2).toUpperCase().optional(),
  originCity: z.string().trim().min(1).optional(),
  destinationUf: z.string().trim().length(2).toUpperCase().optional(),
  destinationCity: z.string().trim().min(1).optional(),
  priceMinCents: z.coerce.number().int().min(0).optional(),
  priceMaxCents: z.coerce.number().int().min(0).optional(),
  sort: z.enum(["valorIda", "km"]).optional(),
});

export type FreightRateFilters = z.infer<typeof freightRateFilterSchema>;

/** Item shape returned by GET /api/freight-rates (nulls preserved, money in centavos). */
export interface FreightRateItem {
  id: string;
  originUf: string;
  originCity: string;
  destinationUf: string;
  destinationCity: string;
  km: number | null;
  vehicleType: string;
  valorIdaCents: number | null;
  valorReversaCents: number | null;
  observacoes: string | null;
}

/** Summary returned by POST /api/freight-rates/import. */
export interface FreightRateImportSummary {
  id: string;
  fileName: string;
  routeCount: number;
  rateCount: number;
}
