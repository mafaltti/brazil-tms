import {
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { importBatches } from "./import-batches";
import { trips } from "./trips";
import { importRowOutcome, importRowMatch } from "./enums";

/**
 * Per-row import record (data-model §3) — one source line of a batch. `raw` is the original parsed
 * cells; `mapped` is the template-resolved trip shape (nullable until validation). `outcome`
 * (`import_row_outcome`) is the validation verdict and `reasons` the structured codes (§11.2,
 * FR-012). `match_decision` (`import_row_match`) is the duplicate verdict keyed on
 * (customer, external trip id) (R7); `target_trip_id` / `applied_at` are set on confirm. Rows are
 * children of the batch (`ON DELETE CASCADE`).
 */
export const importRows = pgTable(
  "import_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importBatchId: uuid("import_batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),
    raw: jsonb("raw").notNull(),
    mapped: jsonb("mapped"),
    outcome: importRowOutcome("outcome"),
    reasons: jsonb("reasons").notNull().default([]),
    matchDecision: importRowMatch("match_decision"),
    targetTripId: uuid("target_trip_id").references(() => trips.id),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("import_rows_batch_row_uq").on(table.importBatchId, table.rowNumber),
    index("import_rows_batch_outcome_idx").on(table.importBatchId, table.outcome),
  ],
);
