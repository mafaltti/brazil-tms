import { z } from "zod";
import { dateStringSchema } from "./master-data";

/**
 * Feature 009 — the audit-log query schema (contracts/bff-endpoints §4, data-model §5). EXTENDS the
 * slice-001 inline filters (`entityType`/`entityId`/`action`) with the §21.5 forensic dimensions:
 * `actorUserId`, a `from`/`to` date range (over `created_at`), and `limit`/`offset` pagination. ONE
 * validated parse shared by the extended `GET /api/admin/audit-logs` route and the audit screen's
 * filter bar. The view stays gated on `view_audit_log` (Admin); the read is append-only (Constitution
 * III). `from`/`to` are São Paulo calendar-day strings (`YYYY-MM-DD`), resolved to half-open BRT day
 * boundaries in the read model (`to` inclusive of its day) — the same convention the reports use, so a
 * date-only filter never excludes that day's records or drifts by the UTC offset.
 */

const optParam = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === "" || v === null ? undefined : v), schema.optional());

const uuidParam = (label: string) => optParam(z.string().uuid(`${label} inválido.`));

export const AUDIT_LOG_DEFAULT_LIMIT = 50;
export const AUDIT_LOG_MAX_LIMIT = 200;

export const auditLogQuerySchema = z.object({
  // existing slice-001 filters
  entityType: optParam(z.string().trim().min(1).max(100)),
  entityId: uuidParam("Entidade"),
  action: optParam(z.string().trim().min(1).max(100)),
  // NEW (009) — actor + date range (SP calendar days) + pagination
  actorUserId: uuidParam("Autor"),
  from: optParam(dateStringSchema),
  to: optParam(dateStringSchema),
  limit: z.coerce
    .number()
    .int("Limite inválido.")
    .min(1, "O limite deve ser ao menos 1.")
    .max(AUDIT_LOG_MAX_LIMIT, `O limite máximo é ${AUDIT_LOG_MAX_LIMIT}.`)
    .default(AUDIT_LOG_DEFAULT_LIMIT),
  offset: z.coerce.number().int("Deslocamento inválido.").min(0, "Deslocamento inválido.").default(0),
});

export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

const PARAM_KEYS = [
  "entityType",
  "entityId",
  "action",
  "actorUserId",
  "from",
  "to",
  "limit",
  "offset",
] as const;

function rawFromParams(params: URLSearchParams): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const key of PARAM_KEYS) {
    const value = params.get(key);
    if (value !== null) raw[key] = value;
  }
  return raw;
}

/** Parse + validate the audit-log query from URL search params (route + client share this). */
export function auditLogFromParams(params: URLSearchParams): AuditLogQuery {
  return auditLogQuerySchema.parse(rawFromParams(params));
}
