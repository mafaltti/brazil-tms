import "server-only";

/**
 * Feature 008 — server-only re-export of the document services (US1). The implementation lives in
 * `@brazil-tms/db`; this boundary re-applies the `server-only` guard for the Next app.
 */
export {
  uploadDocument,
  verifyDocument,
  archiveDocument,
  getDocumentFileKey,
  assertUploadable,
} from "@brazil-tms/db";
