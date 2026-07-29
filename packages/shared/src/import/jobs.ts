/**
 * pg-boss job names + payloads for the import pipeline (feature 004, research R3). Shared by the BFF
 * (enqueue) and the worker (enqueue + work) so both sides agree on one contract. PURE — no pg-boss
 * import, so this stays safe to include from `@brazil-tms/shared`.
 *
 * Pipeline: parse → validate → detect-duplicates (→ generate-error-report when error_count > 0);
 * confirm is enqueued by the user's confirm action.
 */

export const IMPORT_JOBS = {
  parse: "import.parse",
  validate: "import.validate",
  detectDuplicates: "import.detect-duplicates",
  generateErrorReport: "import.generate-error-report",
  confirm: "import.confirm",
} as const;

export type ImportJobName = (typeof IMPORT_JOBS)[keyof typeof IMPORT_JOBS];

export interface ParsePayload {
  batchId: string;
  storageKey: string;
}
export interface ValidatePayload {
  batchId: string;
}
export interface DetectDuplicatesPayload {
  batchId: string;
}
export interface GenerateErrorReportPayload {
  batchId: string;
}
export interface ConfirmPayload {
  batchId: string;
  actorUserId: string;
}

export interface ImportJobPayloads {
  "import.parse": ParsePayload;
  "import.validate": ValidatePayload;
  "import.detect-duplicates": DetectDuplicatesPayload;
  "import.generate-error-report": GenerateErrorReportPayload;
  "import.confirm": ConfirmPayload;
}
