import { sql } from "drizzle-orm";
import { check, date, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { carriers } from "./carriers";
import { ownershipType, resourceStatus, trailerType } from "./enums";

/**
 * Trailer resource (data-model §6; RES-005, "where applicable"). Same shape as a vehicle but with
 * `trailer_type` and no tracker fields. `plate` is globally unique. Ownership/carrier CHECK mirrors
 * drivers/vehicles (R4). `document_expiry` feeds the derived expiry warning (R9). Operations without
 * trailers simply create none.
 */
export const trailers = pgTable(
  "trailers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    plate: text("plate").notNull().unique(),
    trailerType: trailerType("trailer_type").notNull(),
    capacityKg: integer("capacity_kg"),
    ownershipType: ownershipType("ownership_type").notNull(),
    carrierId: uuid("carrier_id").references(() => carriers.id),
    owner: text("owner"),
    documentExpiry: date("document_expiry"),
    status: resourceStatus("status").notNull().default("active"),
    notes: text("notes"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "trailers_ownership_carrier_ck",
      sql`(${table.ownershipType} = 'subcontracted' AND ${table.carrierId} IS NOT NULL) OR (${table.ownershipType} = 'owned' AND ${table.carrierId} IS NULL)`,
    ),
    index("trailers_carrier_idx").on(table.carrierId),
    index("trailers_status_idx").on(table.status),
  ],
);
