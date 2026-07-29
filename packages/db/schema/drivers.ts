import { sql } from "drizzle-orm";
import { check, date, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { carriers } from "./carriers";
import { ownershipType, resourceStatus } from "./enums";

/**
 * Driver resource (data-model §4; RES-001, RES-002). `ownership_type` is mandatory (R4) and a CHECK
 * enforces the invariant `subcontracted ⇒ carrier_id set` / `owned ⇒ carrier_id null`. `status` is
 * the operational `resource_status` (R3), orthogonal to `archived_at`. `license_expiry` feeds the
 * derived documentation-expiry warning (R9, computed in the service, never stored).
 *
 * `email` is DORMANT (issue #28 [0005] replaced it with `cpf` across the product surface): the
 * column must stay mapped here — removing it makes the next `drizzle-kit generate` emit a
 * data-destroying DROP COLUMN — but nothing reads or writes it anymore.
 */
export const drivers = pgTable(
  "drivers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    phone: text("phone"),
    email: text("email"), // dormant — see the table doc comment
    cpf: text("cpf"),
    licenseNumber: text("license_number"),
    licenseCategory: text("license_category"),
    licenseExpiry: date("license_expiry"),
    ownershipType: ownershipType("ownership_type").notNull(),
    carrierId: uuid("carrier_id").references(() => carriers.id),
    employer: text("employer"),
    status: resourceStatus("status").notNull().default("active"),
    notes: text("notes"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "drivers_ownership_carrier_ck",
      sql`(${table.ownershipType} = 'subcontracted' AND ${table.carrierId} IS NOT NULL) OR (${table.ownershipType} = 'owned' AND ${table.carrierId} IS NULL)`,
    ),
    index("drivers_carrier_idx").on(table.carrierId),
    index("drivers_status_idx").on(table.status),
  ],
);
