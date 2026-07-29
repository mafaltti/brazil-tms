import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Feature 008 — proof-document type master (data-model §2, clarify Q2). A configurable admin-managed
 * vocabulary (mirrors `reason_codes`): `text` code + pt-BR label, NOT a pgEnum — new proof types need
 * no migration (Constitution V). Referenced by `documents.document_type_id` and
 * `document_requirements.document_type_id`. Mutable (admin edits via `manage_commercial_data`) → NO
 * REVOKE.
 */
export const documentTypes = pgTable("document_types", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  labelPt: text("label_pt").notNull(),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
