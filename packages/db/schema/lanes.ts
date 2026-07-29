import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  numeric,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { customers } from "./customers";
import { locations } from "./locations";
import { vehicleType } from "./enums";

/**
 * Origin→destination lane for a customer (data-model §3; LANE-003, LANE-004). Both endpoints are
 * FKs into `locations`; a CHECK forbids the degenerate origin = destination lane. The cross-row
 * rule "origin/destination/customer all active and same customer" spans rows and is enforced in the
 * service layer (R5, `409 INVALID_LANE_REFERENCE`), not as a CHECK. Money is integer centavos, BRL
 * (R7); `default_vehicle_type` shares the `vehicle_type` enum for later lane↔vehicle matching.
 */
export const lanes = pgTable(
  "lanes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    originLocationId: uuid("origin_location_id")
      .notNull()
      .references(() => locations.id),
    destinationLocationId: uuid("destination_location_id")
      .notNull()
      .references(() => locations.id),
    expectedTransitMinutes: integer("expected_transit_minutes"),
    defaultVehicleType: vehicleType("default_vehicle_type"),
    standardRateCents: bigint("standard_rate_cents", { mode: "number" }),
    tollEstimateCents: bigint("toll_estimate_cents", { mode: "number" }),
    standardDistanceKm: numeric("standard_distance_km"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "lanes_origin_dest_ck",
      sql`${table.originLocationId} <> ${table.destinationLocationId}`,
    ),
    index("lanes_customer_idx").on(table.customerId),
    index("lanes_origin_idx").on(table.originLocationId),
    index("lanes_dest_idx").on(table.destinationLocationId),
  ],
);
