import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Subcontracting carrier (data-model §7; RES-006). `tax_id` is UNIQUE when present (Postgres treats
 * NULLs as distinct, giving "unique only when set"). `contact` is jsonb (R8). `contract_status` and
 * `documentation_status` are text + CHECK (documented-default value sets, R6 / Constitution II) so
 * Ops can adjust the small set without a type migration. Soft-delete via `archived_at`.
 * `approved_customers` / `approved_lanes` are deferred to feature 006 (R12).
 */
export const carriers = pgTable(
  "carriers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    legalName: text("legal_name"),
    taxId: text("tax_id").unique(),
    contact: jsonb("contact"),
    contractStatus: text("contract_status").notNull().default("active"),
    documentationStatus: text("documentation_status").notNull().default("pending"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "carriers_contract_status_ck",
      sql`${table.contractStatus} in ('active', 'suspended', 'expired')`,
    ),
    check(
      "carriers_documentation_status_ck",
      sql`${table.documentationStatus} in ('pending', 'complete', 'expired')`,
    ),
  ],
);
