import "server-only";

/**
 * Feature 008 — server-only re-export of the document-requirement + document-type admin services and
 * reads (US3). Gated `manage_commercial_data` at the BFF.
 */
export {
  createDocumentRequirement,
  updateDocumentRequirement,
  listDocumentRequirements,
  createDocumentType,
  updateDocumentType,
  listDocumentTypes,
  queryDocumentRequirements,
} from "@brazil-tms/db";
