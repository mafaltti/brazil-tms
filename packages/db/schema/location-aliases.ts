import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { customers } from "./customers";
import { locations } from "./locations";
import { users } from "./users";

/**
 * Per-customer location alias (data-model §5) — config row mapping a raw file location string
 * (`file_value`) to a resolved 002 `location_id` (R8, Constitution V): lets the import engine
 * resolve customer-specific naming without per-customer code. Unique per (customer, file value);
 * `created_by` records who taught the alias.
 */
export const locationAliases = pgTable(
  "location_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    fileValue: text("file_value").notNull(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("location_aliases_customer_file_value_uq").on(table.customerId, table.fileValue),
  ],
);
