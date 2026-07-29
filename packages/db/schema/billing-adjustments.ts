import { bigint, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { billingItems } from "./billing-items";
import { users } from "./users";
import { billingAdjustmentType } from "./enums";

/**
 * Feature 008 — typed billing adjustment line (data-model §6; BILL-004/005, FR-016). Each row is one
 * `type` + signed `amount_cents` (bigint) + optional `note` + author — the simplest model that
 * satisfies "add each adjustment with an amount and a note" (aggregate columns cannot, R6). Computed
 * planned/executed/adjustment/final are derived by `computeBillingValues` over the LIVE rows
 * (`removed_at IS NULL`). Soft-remove (`removed_at`/`removed_by_user_id`), never hard-delete a
 * financial row (Constitution III). Mutable (`edit_rates`) → NO REVOKE.
 */
export const billingAdjustments = pgTable(
  "billing_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    billingItemId: uuid("billing_item_id")
      .notNull()
      .references(() => billingItems.id),
    type: billingAdjustmentType("type").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    note: text("note"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedByUserId: uuid("removed_by_user_id").references(() => users.id),
  },
  (table) => [index("billing_adjustments_item_idx").on(table.billingItemId)],
);
