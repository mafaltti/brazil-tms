import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { customers } from "./customers";

/**
 * Per-customer import template (data-model §1) — the config-driven mapping for one customer's
 * file shape (R8, Constitution V): `column_mappings` / `parsing_rules` / `required_overrides` are
 * jsonb (shape enforced by Zod templates in `@brazil-tms/shared`, not the DB). Versioned per
 * (customer, name); soft-delete via nullable `archived_at`. One import engine, no per-customer code.
 */
export const importTemplates = pgTable(
  "import_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    fileType: text("file_type").notNull(),
    columnMappings: jsonb("column_mappings").notNull(),
    parsingRules: jsonb("parsing_rules").notNull().default({}),
    requiredOverrides: jsonb("required_overrides").notNull().default([]),
    active: boolean("active").notNull().default(true),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("import_templates_file_type_ck", sql`${table.fileType} in ('csv','xlsx')`),
    uniqueIndex("import_templates_customer_name_version_uq").on(
      table.customerId,
      table.name,
      table.version,
    ),
  ],
);
