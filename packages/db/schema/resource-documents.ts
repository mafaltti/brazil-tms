import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Slice 025 (issue #32 [0009]) — registry attachments for drivers and vehicles ("Documentos" tab):
 * an APPEND-ONLY upload history. Deliberately separate from the shipped 008 `documents` table,
 * which is trip-scoped and carries verification/billing semantics that do not apply here.
 *
 * The binary lives ONLY in Supabase Storage (private `documents` bucket, `resources/…` key —
 * STACK §3.9); this row is metadata. `entity_type` is a CHECK-constrained text (not a pgEnum) so
 * adding `trailer` later is a one-line CHECK swap, not enum surgery. `entity_id` is polymorphic
 * (drivers.id or vehicles.id) — the service preflights existence; no cross-table FK is possible.
 * No update/delete surface: history is the product requirement (append-only + audit per upload).
 */
export const resourceDocuments = pgTable(
  "resource_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: text("entity_type").$type<"driver" | "vehicle">().notNull(),
    entityId: uuid("entity_id").notNull(),
    docType: text("doc_type").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    fileStorageKey: text("file_storage_key").notNull().unique(),
    uploadedByUserId: uuid("uploaded_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "resource_documents_entity_type_ck",
      sql`${table.entityType} IN ('driver', 'vehicle')`,
    ),
    index("resource_documents_entity_idx").on(table.entityType, table.entityId, table.createdAt),
  ],
);
