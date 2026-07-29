import "server-only";

/**
 * Feature 009 — server-only re-export of the extended audit-history read model (US4). The
 * `GET /api/admin/audit-logs` route imports `queryAuditLog` from here (mirrors `lib/trips/reporting.ts`).
 * Read-only over the append-only `audit_logs`.
 */
export { queryAuditLog } from "@brazil-tms/db";
