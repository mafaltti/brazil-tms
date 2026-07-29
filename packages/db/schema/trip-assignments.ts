import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { trips } from "./trips";
import { drivers } from "./drivers";
import { vehicles } from "./vehicles";
import { trailers } from "./trailers";
import { carriers } from "./carriers";
import { users } from "./users";

/**
 * Trip assignment — the dispatch write surface over the trip domain (PRD §14.1; data-model §1;
 * DISP-001..009). One row binds a driver/vehicle/trailer/carrier to a trip. Built read-only on 002
 * master data and 003's trip model: FKs use inline `.references(() => x.id)` with default
 * `ON DELETE no action` (master data is archived, not deleted — assignments never dangle).
 *
 * Invariants (R1, R2, R4):
 *   - **At most one current assignment per trip** — the partial unique index
 *     `trip_assignments_trip_active_uq ON (trip_id) WHERE is_current` (mirrors `trips`'
 *     `trips_customer_external_id_uq`). A concurrent second assign loses at the DB and surfaces 409.
 *   - **Mutable current row, retained history** — confirmation updates the current row
 *     (`confirmed_by/at`); reassignment supersedes the prior row (`is_current=false`,
 *     `superseded_by_assignment_id`, `superseded_at`) and inserts a new current row in one tx. Rows
 *     are **never hard-deleted**; superseded rows are immutable history. No REVOKE (rows are updated
 *     by design — Constitution III; the append-only record stays in `trip_events`/`audit_logs`).
 *
 * No `assignment_status` enum (the `is_current` + supersession chain covers it) and **no `trips`
 * column change** (R3): the current assignment is read via
 * `trip_assignments WHERE trip_id=? AND is_current` — a single hit on the partial unique index, not a
 * denormalized `trips.current_assignment_id` that could drift.
 */
export const tripAssignments = pgTable(
  "trip_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id),
    driverId: uuid("driver_id").references(() => drivers.id),
    vehicleId: uuid("vehicle_id").references(() => vehicles.id),
    trailerId: uuid("trailer_id").references(() => trailers.id),
    carrierId: uuid("carrier_id").references(() => carriers.id),
    assignedByUserId: uuid("assigned_by_user_id")
      .notNull()
      .references(() => users.id),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    notes: text("notes"),
    overrideReason: text("override_reason"),
    isCurrent: boolean("is_current").notNull().default(true),
    // Self-FK: reassignment points a superseded row at the row that replaced it (history chain).
    supersededByAssignmentId: uuid("superseded_by_assignment_id").references(
      (): AnyPgColumn => tripAssignments.id,
    ),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // At most one CURRENT assignment per trip (R2; mirrors trips_customer_external_id_uq).
    uniqueIndex("trip_assignments_trip_active_uq").on(table.tripId).where(sql`${table.isCurrent}`),
    // History lookups by trip.
    index("trip_assignments_trip_idx").on(table.tripId),
    // Conflict-lookup (schedule overlap) — current assignments per resource only.
    index("trip_assignments_driver_active_idx").on(table.driverId).where(sql`${table.isCurrent}`),
    index("trip_assignments_vehicle_active_idx").on(table.vehicleId).where(sql`${table.isCurrent}`),
    index("trip_assignments_trailer_active_idx").on(table.trailerId).where(sql`${table.isCurrent}`),
    index("trip_assignments_carrier_active_idx").on(table.carrierId).where(sql`${table.isCurrent}`),
  ],
);
