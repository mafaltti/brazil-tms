import { boolean, index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { customers } from "./customers";
import { lanes } from "./lanes";
import { documentTypes } from "./document-types";
import { vehicleType } from "./enums";

/**
 * Feature 008 — per-customer required-document checklist (data-model §4; CUST-004, DOC-003/005). A row
 * applies to a trip when `customer_id` matches AND `active` AND (`lane_id` IS NULL OR = trip.lane_id)
 * AND (`vehicle_type` IS NULL OR = trip.planned_vehicle_type) — unscoped rows apply to all the
 * customer's trips; scoped rows ADD when matched (additive). Absence of any rows for a customer ⇒ the
 * `DEFAULT_DOCUMENT_CHECKLIST` constant + that customer's document-checklist sign-off reported blocked
 * (§29 Input #3). Per-customer commercial config (`manage_commercial_data`). Mutable → NO REVOKE.
 */
export const documentRequirements = pgTable(
  "document_requirements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    documentTypeId: uuid("document_type_id")
      .notNull()
      .references(() => documentTypes.id),
    requiredForCompletion: boolean("required_for_completion").notNull().default(false),
    requiredForBilling: boolean("required_for_billing").notNull().default(true),
    laneId: uuid("lane_id").references(() => lanes.id),
    vehicleType: vehicleType("vehicle_type"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("document_requirements_customer_idx").on(table.customerId),
    index("document_requirements_scope_idx").on(table.customerId, table.laneId, table.vehicleType),
  ],
);
