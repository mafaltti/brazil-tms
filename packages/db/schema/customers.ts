import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Commercial customer (data-model §1; CUST-001, CUST-002). `customer_code` is globally unique.
 * `contacts` (array) and `billing_contact` (single) are jsonb (R8) — shape enforced by Zod at the
 * BFF boundary, not the DB. Soft-delete via nullable `archived_at` (R1). SLA / document-requirement
 * / import-template columns are intentionally NOT here — they belong to features 007 / 008 / 004 (R12).
 */
export const customers = pgTable("customers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  legalName: text("legal_name"),
  customerCode: text("customer_code").notNull().unique(),
  taxId: text("tax_id"),
  contacts: jsonb("contacts").notNull().default([]),
  billingContact: jsonb("billing_contact"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
