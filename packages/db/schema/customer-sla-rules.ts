import { boolean, index, integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { customers } from "./customers";
import { lanes } from "./lanes";
import { vehicleType } from "./enums";

/**
 * Feature 007 — per-customer SLA rules (PRD §14.1, CUST-005). Reuses the existing `vehicle_type` enum
 * (no new enum). The single-applicable-rule precedence (lane > vehicle-type > customer-default,
 * tie-break latest `effective_start`) is resolved in the evaluator's query — NOT a DB constraint (R3;
 * no exclusion/btree_gist). A customer with no matching row runs on `DEFAULT_SLA_POLICY` and is
 * reported SLA sign-off blocked (FR-022). Mutable → NO REVOKE.
 */
export const customerSlaRules = pgTable(
  "customer_sla_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    laneId: uuid("lane_id").references(() => lanes.id),
    vehicleType: vehicleType("vehicle_type"),
    pickupToleranceMinutes: integer("pickup_tolerance_minutes").notNull(),
    deliveryToleranceMinutes: integer("delivery_tolerance_minutes").notNull(),
    confirmationCutoffMinutes: integer("confirmation_cutoff_minutes").notNull(),
    atRiskWarningMinutes: integer("at_risk_warning_minutes").notNull(),
    effectiveStart: timestamp("effective_start", { withTimezone: true }),
    effectiveEnd: timestamp("effective_end", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("customer_sla_rules_customer_idx").on(table.customerId),
    index("customer_sla_rules_scope_idx").on(table.customerId, table.laneId, table.vehicleType),
  ],
);
