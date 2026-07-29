import {
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { customers } from "./customers";

/**
 * Customer-scoped site (data-model §2; LANE-001, LANE-002, Clarification Q3). `customer_id` is a
 * NOT NULL FK — locations belong to exactly one customer (R5); `code` is unique *per customer*
 * (`UNIQUE(customer_id, code)`), so one customer's sites never collide with another's. `country`
 * defaults `'BR'`; `state` is the 2-letter UF (Zod-validated). Soft-delete via `archived_at`.
 */
export const locations = pgTable(
  "locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    address: text("address"),
    city: text("city"),
    state: text("state"),
    country: text("country").notNull().default("BR"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    gateInstructions: text("gate_instructions"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("locations_customer_code_unique").on(table.customerId, table.code),
    index("locations_customer_idx").on(table.customerId),
  ],
);
