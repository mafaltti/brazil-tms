import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { trips } from "./trips";
import { customers } from "./customers";
import { rates } from "./rates";
import { exportBatches } from "./export-batches";

/**
 * Feature 008 — billing item (data-model §6; BILL-001/003/005). One per trip (unique `trip_id`),
 * created at billing-phase entry by `ensureBillingItem`. `base_freight_cents` = the executed value
 * (rate-derived or manual; FR-017), NULL until priced. Billing lifecycle status is the
 * `billingStatus(current_status)` projection (FR-011) — NO status column. `dispute_status` is the
 * open-billing-dispute flag the §19.4 gate reads (CHECK text). `export_batch_id` links the item to its
 * export run (a forward FK — `export_batches` is created before `billing_items` in the migration).
 * Computed planned/executed/adjustment/final values are DERIVED (`computeBillingValues`), never stored.
 * Mutable (`edit_rates`) → NO REVOKE.
 */
export const billingItems = pgTable(
  "billing_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    rateId: uuid("rate_id").references(() => rates.id),
    baseFreightCents: bigint("base_freight_cents", { mode: "number" }),
    currency: text("currency").notNull().default("BRL"),
    billingPeriod: text("billing_period").notNull(),
    disputeStatus: text("dispute_status").notNull().default("none"),
    exportBatchId: uuid("export_batch_id").references(() => exportBatches.id),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("billing_items_dispute_status_ck", sql`${table.disputeStatus} IN ('none','open','resolved')`),
    uniqueIndex("billing_items_trip_uq").on(table.tripId),
    index("billing_items_customer_period_idx").on(table.customerId, table.billingPeriod),
    index("billing_items_export_batch_idx").on(table.exportBatchId),
  ],
);
