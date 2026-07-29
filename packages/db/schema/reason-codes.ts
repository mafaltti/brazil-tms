import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { exceptionResponsibleParty, exceptionSeverity } from "./enums";

/**
 * Feature 007 — exception reason-code config (PRD §14.1, EXC-004). Business-mutable value set →
 * `category` is text + CHECK over the 12 EXC-004 values (mirrors `cancellation_options.kind`), NOT a
 * pgEnum. `default_severity`/`default_responsible_party` ARE enums (the fixed exception scales) and
 * pre-fill create-exception inputs. The exception category is DERIVED from this table via
 * `exceptions.reason_code_id`, never stored on `exceptions` (R1, single-source). Mutable → NO REVOKE.
 */
export const reasonCodes = pgTable(
  "reason_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    category: text("category").notNull(),
    labelPt: text("label_pt").notNull(),
    defaultSeverity: exceptionSeverity("default_severity").notNull(),
    defaultResponsibleParty: exceptionResponsibleParty("default_responsible_party").notNull(),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "reason_codes_category_ck",
      sql`${table.category} IN ('delay','no_show','breakdown','driver_issue','customer_delay','loading_delay','unloading_delay','documentation','accident','route_deviation','cancellation','other')`,
    ),
  ],
);
