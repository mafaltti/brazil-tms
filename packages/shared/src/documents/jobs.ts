/**
 * Feature 008 — the scheduled document-checks sweep contract (data-model §9.3, R11). The SECOND
 * scheduled worker job (after 007's `sla.sweep`): a ~5-min cron that lights up the two deferred §17
 * alert cases (`completed_missing_documents`, `billing_blocked_missing_proof`) via the 007 `alerts`
 * store. Scheduled cron has no per-run input.
 */
export const DOCUMENT_JOBS = {
  documentChecks: "documents.checks",
} as const;

export type DocumentJobName = (typeof DOCUMENT_JOBS)[keyof typeof DOCUMENT_JOBS];

/** Scheduled cron has no per-run input. */
export type DocumentChecksPayload = Record<string, never>;

export interface DocumentJobPayloads {
  "documents.checks": DocumentChecksPayload;
}
