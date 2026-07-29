import { bigint, boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { customers } from "./customers";
import { lanes } from "./lanes";
import { vehicleType } from "./enums";

/**
 * Feature 008 — simple rates (data-model §5; BILL-002/003). Money is integer centavos, BRL (codebase
 * convention — `lanes.standard_rate_cents` is `bigint({mode:'number'})`). Single-applicable-rate
 * precedence (lane+vehicle-type > single-scope > customer-default, tie-break latest `effective_start`)
 * is resolved in the resolver query, NOT a DB constraint (R4). The toll/waiting/extra-stop rule texts
 * are gated §29 Input #5 placeholders — stored but NOT interpreted in MVP. Mutable (`edit_rates`) → NO
 * REVOKE.
 */
export const rates = pgTable(
  "rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    laneId: uuid("lane_id").references(() => lanes.id),
    vehicleType: vehicleType("vehicle_type"),
    baseAmountCents: bigint("base_amount_cents", { mode: "number" }).notNull(),
    currency: text("currency").notNull().default("BRL"),
    tollHandlingRule: text("toll_handling_rule"),
    waitingTimeRule: text("waiting_time_rule"),
    extraStopRule: text("extra_stop_rule"),
    effectiveStart: timestamp("effective_start", { withTimezone: true }),
    effectiveEnd: timestamp("effective_end", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("rates_customer_idx").on(table.customerId),
    index("rates_scope_idx").on(table.customerId, table.laneId, table.vehicleType),
  ],
);
