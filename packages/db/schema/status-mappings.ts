import {
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { TripStatus } from "@brazil-tms/shared";
import { customers } from "./customers";
import { tripStatus } from "./enums";

/**
 * Per-customer status mapping (data-model §4) — config row translating a customer's file status
 * label (`customer_label`) to the single internal `trip_status` (R8, Constitution V): config-driven,
 * not per-customer code. Unique per (customer, label); soft-delete via nullable `archived_at`.
 *
 * slice 015: `internal_status` is pinned to the 16-value active `TripStatus` via `.$type<>()` (the
 * upsert path already validates against `TRIP_STATUSES`); the dormant `validation_error`/`validated`
 * values are not valid mapping targets. Type-only — no SQL diff.
 */
export const statusMappings = pgTable(
  "status_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    customerLabel: text("customer_label").notNull(),
    internalStatus: tripStatus("internal_status").notNull().$type<TripStatus>(),
    active: boolean("active").notNull().default(true),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("status_mappings_customer_label_uq").on(table.customerId, table.customerLabel),
  ],
);
