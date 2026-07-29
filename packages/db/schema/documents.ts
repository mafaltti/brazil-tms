import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { trips } from "./trips";
import { users } from "./users";
import { documentTypes } from "./document-types";
import { documentVerificationStatus } from "./enums";

/**
 * Feature 008 — proof-of-execution documents (data-model §3; DOC-001/002/004/006; waiver R3). One row
 * per uploaded proof OR per audited waiver. The binary lives only in Supabase Storage
 * (`file_storage_key`); never in Postgres (STACK §3.9). A waiver row has `file_storage_key = NULL` +
 * `waived_at`/`waived_reason`/`waived_by_user_id` — the `documents_file_or_waiver_ck` CHECK guarantees
 * a row is EITHER an upload OR a waiver. A required type is satisfied for a trip iff there is a
 * non-archived row with `verification_status='accepted'` OR `waived_at IS NOT NULL`. Soft-delete via
 * `archived_at` (never hard-delete — Constitution III). Mutable (verify/waive/archive) → NO REVOKE.
 */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id),
    documentTypeId: uuid("document_type_id")
      .notNull()
      .references(() => documentTypes.id),
    fileStorageKey: text("file_storage_key"),
    externalReference: text("external_reference"),
    uploadedByUserId: uuid("uploaded_by_user_id")
      .notNull()
      .references(() => users.id),
    verificationStatus: documentVerificationStatus("verification_status")
      .notNull()
      .default("pending_review"),
    verifiedByUserId: uuid("verified_by_user_id").references(() => users.id),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    waivedAt: timestamp("waived_at", { withTimezone: true }),
    waivedReason: text("waived_reason"),
    waivedByUserId: uuid("waived_by_user_id").references(() => users.id),
    notes: text("notes"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "documents_file_or_waiver_ck",
      sql`${table.fileStorageKey} IS NOT NULL OR ${table.waivedAt} IS NOT NULL`,
    ),
    index("documents_trip_idx").on(table.tripId),
    index("documents_type_idx").on(table.documentTypeId),
    index("documents_verification_idx").on(table.verificationStatus),
  ],
);
