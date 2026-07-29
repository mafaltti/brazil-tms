import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { trips } from "./trips";
import { exceptions } from "./exceptions";
import { users } from "./users";
import { locations } from "./locations";
import { tripEventSource, tripEventType, tripStatus } from "./enums";

/**
 * Append-only trip event (data-model §2; FR-006, FR-007, FR-015). Records the ACTUAL milestones of a
 * trip — separate from the planned columns on `trips` (R4/R6). Every status transition also inserts a
 * `status_change` row here (with `status_before`/`status_after`) inside the same transaction as the
 * `trips` update + the audit write (R6), so a transition is never unlogged (SC-003).
 *
 * Like `audit_logs`, this table has no `updated_at`/`deleted_at`; the app exposes only insert + select.
 * Append-only hardening (`REVOKE UPDATE, DELETE ... FROM PUBLIC`) is hand-added to the migration —
 * drizzle-kit will not emit it (FR-017, data-model §Append-only enforcement).
 *
 * `event_timestamp` is the actual time of the milestone (UTC, nullable); `created_at` is the
 * DB-recorded insert time. `exception_id` is a forward hook with NO FK until 007 owns `exceptions`.
 */
export const tripEvents = pgTable(
  "trip_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id),
    eventType: tripEventType("event_type").notNull(),
    statusBefore: tripStatus("status_before"),
    statusAfter: tripStatus("status_after"),
    eventTimestamp: timestamp("event_timestamp", { withTimezone: true }),
    source: tripEventSource("source").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    locationId: uuid("location_id").references(() => locations.id),
    notes: text("notes"),
    // feature 007 — wires the 003 forward-hook FK (the column already existed; 007 owns `exceptions`).
    exceptionId: uuid("exception_id").references(() => exceptions.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("trip_events_trip_idx").on(table.tripId, table.createdAt.desc()),
    index("trip_events_type_idx").on(table.eventType),
  ],
);
