import "server-only";

/**
 * Server-only re-export of the canonical Supabase Storage helper (feature 004, T022/R12). The
 * implementation lives in `@brazil-tms/db` so the import worker can share it; this boundary re-applies
 * the `server-only` guard for the Next app (the service-role key must never reach the browser —
 * Constitution IV). The BFF uses `putOriginal` (upload route) and `signedUrl` (error-report download).
 */
export {
  putOriginal,
  putErrorReport,
  downloadObject,
  signedUrl,
  importBucket,
  originalStorageKey,
  errorReportStorageKey,
  // Feature 008 — documents + billing-export binaries (two new private buckets).
  putDocument,
  putExport,
  removeObject,
  documentStorageKey,
  exportStorageKey,
  documentsBucket,
  exportsBucket,
  // Slice 025 — driver/vehicle registry attachments (same documents bucket, resources/ prefix).
  resourceDocumentStorageKey,
} from "@brazil-tms/db/storage";
