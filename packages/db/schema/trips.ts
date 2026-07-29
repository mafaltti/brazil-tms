import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { TripStatus } from "@brazil-tms/shared";
import { customers } from "./customers";
import { locations } from "./locations";
import { lanes } from "./lanes";
import {
  cancellationResponsibleParty,
  tripStatus,
  vehicleType,
} from "./enums";

/**
 * Durable trip — the operations system-of-record (data-model §1; TRIP-006, TRIP-007,
 * FR-001..FR-012, FR-015..FR-022). Built on 002 master data: `customer_id`, both location ends, and
 * the optional `lane_id` are FKs into 002 (`ON DELETE NO ACTION` — master data is archived, not
 * deleted, so trips never dangle).
 *
 * Planned-vs-executed (TRIP-006, R4) lives in three layers:
 *   1. `original_plan` jsonb — an IMMUTABLE snapshot of the imported plan, written once at create and
 *      never overwritten by any service (SC-002).
 *   2. live `planned_*` columns — the CURRENT accepted plan, updatable only via the audited
 *      `updateTripPlan` service (R5).
 *   3. EXECUTED values are NOT columns — they are `trip_events` rows (R6); an actual arrival never
 *      overwrites a planned column.
 *
 * `current_status` is the single `trip_status` machine (R2); legality is enforced in the service
 * layer against the shared `TRANSITIONS` table, not a DB trigger (R1). `sla_status` is a placeholder
 * NOT computed here (007 owns it). Cancellation columns are set only on transition to `cancelled`;
 * `disputed_from_status` records where `disputed` was entered from for the round-trip (FR-011).
 *
 * Deferred to later slices (R12): assignment columns/`trip_assignments` (006), `exceptions` (007),
 * SLA computation (007), document/rate/billing-export columns (008). `import_batch_id` is a forward
 * hook with no FK until 004.
 */
export const trips = pgTable(
  "trips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    externalTripId: text("external_trip_id"),
    importBatchId: uuid("import_batch_id"),
    originLocationId: uuid("origin_location_id")
      .notNull()
      .references(() => locations.id),
    destinationLocationId: uuid("destination_location_id")
      .notNull()
      .references(() => locations.id),
    laneId: uuid("lane_id").references(() => lanes.id),
    // slice 015: `.$type<TripStatus>()` pins the column to the 16-value active machine (type-only; the
    // pgEnum still has 18 physical members, 2 dormant). No generated SQL diff.
    currentStatus: tripStatus("current_status").notNull().default("received").$type<TripStatus>(),
    slaStatus: text("sla_status"),
    // feature 007 — server-computed SLA risk (D4): `sla_status` stays text (CHECK-validated, no enum);
    // `sla_reasons` is the schema's first `.array()` column (text[]). Both written atomically.
    slaReasons: text("sla_reasons").array(),
    originalPlan: jsonb("original_plan").notNull(),
    plannedPickupWindowStart: timestamp("planned_pickup_window_start", { withTimezone: true }),
    plannedPickupWindowEnd: timestamp("planned_pickup_window_end", { withTimezone: true }),
    plannedDeliveryWindowStart: timestamp("planned_delivery_window_start", { withTimezone: true }),
    plannedDeliveryWindowEnd: timestamp("planned_delivery_window_end", { withTimezone: true }),
    plannedVehicleType: vehicleType("planned_vehicle_type"),
    plannedVolumeUnits: integer("planned_volume_units"),
    plannedWeightKg: integer("planned_weight_kg"),
    plannedPalletCount: integer("planned_pallet_count"),
    plannedRouteNotes: text("planned_route_notes"),
    plannedServiceRequirements: jsonb("planned_service_requirements"),
    cancellationReasonCode: text("cancellation_reason_code"),
    cancellationResponsibleParty: cancellationResponsibleParty("cancellation_responsible_party"),
    cancellationBillingImpact: text("cancellation_billing_impact"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    disputedFromStatus: tripStatus("disputed_from_status").$type<TripStatus>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "trips_origin_dest_ck",
      sql`${table.originLocationId} <> ${table.destinationLocationId}`,
    ),
    // feature 007 — validate sla_status to the four risk states (D4 — text + CHECK, no enum).
    check(
      "trips_sla_status_ck",
      sql`${table.slaStatus} IS NULL OR ${table.slaStatus} IN ('on_track','at_risk','late','breached')`,
    ),
    // A customer's own trip id is unique within that customer when present (import matching/updates).
    uniqueIndex("trips_customer_external_id_uq")
      .on(table.customerId, table.externalTripId)
      .where(sql`${table.externalTripId} IS NOT NULL`),
    index("trips_customer_idx").on(table.customerId),
    index("trips_status_idx").on(table.currentStatus),
    index("trips_created_idx").on(table.createdAt.desc()),
    // 005 (R5): backs date-range filters, the Today/Next-24h views, default active ordering by pickup,
    // and the "trips today by status" dashboard count.
    index("trips_pickup_start_idx").on(table.plannedPickupWindowStart),
  ],
);
