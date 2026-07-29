import { sql } from "drizzle-orm";
import { check, date, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { carriers } from "./carriers";
import { ownershipType, resourceStatus, vehicleType } from "./enums";

/**
 * Vehicle resource (data-model §5; RES-003, RES-004). `plate` is globally unique (BR/Mercosul,
 * Zod-validated). `vehicle_type` is the fixed code enum (R6). Ownership/carrier CHECK mirrors
 * drivers (R4). `owner` is the owned-case lease/finance party; `tracker_*` capture the telemetry
 * provider. `document_expiry` feeds the derived expiry warning (R9). `status` is `resource_status`.
 * `antt_number`/`renavam`/`chassis` are the Brazilian registry identifiers (issue #30 [0007]) —
 * optional, non-unique (the plate stays the only unique key).
 */
export const vehicles = pgTable(
  "vehicles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    plate: text("plate").notNull().unique(),
    vehicleType: vehicleType("vehicle_type").notNull(),
    anttNumber: text("antt_number"),
    renavam: text("renavam"),
    chassis: text("chassis"),
    capacityKg: integer("capacity_kg"),
    ownershipType: ownershipType("ownership_type").notNull(),
    carrierId: uuid("carrier_id").references(() => carriers.id),
    owner: text("owner"),
    trackerProvider: text("tracker_provider"),
    trackerId: text("tracker_id"),
    documentExpiry: date("document_expiry"),
    status: resourceStatus("status").notNull().default("active"),
    notes: text("notes"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "vehicles_ownership_carrier_ck",
      sql`(${table.ownershipType} = 'subcontracted' AND ${table.carrierId} IS NOT NULL) OR (${table.ownershipType} = 'owned' AND ${table.carrierId} IS NULL)`,
    ),
    index("vehicles_carrier_idx").on(table.carrierId),
    index("vehicles_status_idx").on(table.status),
  ],
);
