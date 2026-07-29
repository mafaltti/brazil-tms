import { z } from "zod";
import { dateStringSchema } from "./master-data";

/**
 * Feature 009 — the shared report-filter query schema (contracts/bff-endpoints §1–3, data-model §2).
 * ONE validated parse for the three report endpoints (`/api/reports/{sla,exceptions,billing-readiness}`)
 * and the client filter bar. Filters compose with AND in the read models; an absent customer/lane means
 * "all". `from`/`to` are ISO calendar-day strings (`YYYY-MM-DD`) — the SAME `dateStringSchema` the 005
 * board uses for `pickupFrom`/`pickupTo`, so the period is bucketed on São Paulo day boundaries (not a
 * UTC-midnight `coerce.date`, which would skew the period by the BRT offset). Period membership differs
 * per report (R3); the default period (last completed calendar month) is resolved in `domain/reporting`.
 */

/** Optional scalar param: a blank/null URL value collapses to `undefined` (absent). Mirrors trip-board. */
const optParam = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === "" || v === null ? undefined : v), schema.optional());

const uuidParam = (label: string) => optParam(z.string().uuid(`${label} inválido.`));

export const REPORT_GROUP_BY = ["customer", "lane"] as const;
export type ReportGroupBy = (typeof REPORT_GROUP_BY)[number];

export const reportFilterSchema = z.object({
  customerId: uuidParam("Cliente"),
  laneId: uuidParam("Rota"),
  /** Inclusive São Paulo calendar-day bounds (YYYY-MM-DD); both present ⇒ custom period, else default. */
  from: optParam(dateStringSchema),
  to: optParam(dateStringSchema),
  groupBy: z.enum(REPORT_GROUP_BY).default("customer"),
});

export type ReportFilter = z.infer<typeof reportFilterSchema>;

const PARAM_KEYS = ["customerId", "laneId", "from", "to", "groupBy"] as const;

function rawFromParams(params: URLSearchParams): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const key of PARAM_KEYS) {
    const value = params.get(key);
    if (value !== null) raw[key] = value;
  }
  return raw;
}

/** Parse + validate the report filter from URL search params (route + client share this). */
export function reportFromParams(params: URLSearchParams): ReportFilter {
  return reportFilterSchema.parse(rawFromParams(params));
}
