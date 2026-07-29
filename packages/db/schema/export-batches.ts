import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { customers } from "./customers";
import { users } from "./users";
import { exportBatchStatus } from "./enums";

/**
 * Feature 008 — billing export batch (data-model §7; BILL-007/008) — mirrors `import_batches`. A
 * durable batch record: created `queued` by the BFF (`createExportBatch`), advanced by the on-demand
 * `billing.export` worker job (`queued → running → completed | failed`), with counts + `error_message`
 * on failure. The file (`file_storage_key`) lands in the `billing-exports` bucket. `format` is CHECK
 * text ('csv'|'xlsx'). Mutable (status progression) → NO REVOKE.
 */
export const exportBatches = pgTable(
  "export_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    billingPeriod: text("billing_period").notNull(),
    format: text("format").notNull(),
    fileStorageKey: text("file_storage_key"),
    generatedByUserId: uuid("generated_by_user_id")
      .notNull()
      .references(() => users.id),
    status: exportBatchStatus("status").notNull().default("queued"),
    tripCount: integer("trip_count").notNull().default(0),
    totalAmountCents: bigint("total_amount_cents", { mode: "number" }).notNull().default(0),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("export_batches_format_ck", sql`${table.format} IN ('csv','xlsx')`),
    index("export_batches_customer_idx").on(table.customerId),
    index("export_batches_created_idx").on(table.createdAt.desc()),
  ],
);
