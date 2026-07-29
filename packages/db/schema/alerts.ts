import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { trips } from "./trips";
import { users } from "./users";
import { exceptionSeverity } from "./enums";

/**
 * Feature 007 — in-app alerts (PRD §17, FR-023/024). `alert_case` is text + CHECK over all 8 §17
 * cases incl. the 2 deferred to 008/009 (so they wire with no `CREATE TYPE`); `state` is text + CHECK.
 * `severity` reuses `exception_severity` (one scale, KISS). The partial-unique on a
 * `state IN ('active','acknowledged')` predicate (D3) mirrors 006's `is_current` partial-unique: at
 * most one not-yet-cleared alert per (trip, case); a `resolved` row falls outside the predicate so a
 * later recurrence inserts a fresh row. Mutable (acknowledge/resolve) → NO REVOKE; acknowledgement is
 * tracked on the row, NOT as an audit action (view triage). In-app only — no external-channel column.
 */
export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id),
    alertCase: text("alert_case").notNull(),
    severity: exceptionSeverity("severity").notNull(),
    state: text("state").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedByUserId: uuid("acknowledged_by_user_id").references(() => users.id),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    autoResolvedAt: timestamp("auto_resolved_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "alerts_case_ck",
      sql`${table.alertCase} IN ('unassigned_within_window','unconfirmed_within_window','missed_origin_arrival','missed_departure','missed_destination_arrival','high_severity_exception','completed_missing_documents','billing_blocked_missing_proof')`,
    ),
    check("alerts_state_ck", sql`${table.state} IN ('active','acknowledged','resolved')`),
    uniqueIndex("alerts_trip_case_open_uq")
      .on(table.tripId, table.alertCase)
      .where(sql`${table.state} IN ('active', 'acknowledged')`),
    index("alerts_trip_idx").on(table.tripId),
    index("alerts_state_idx").on(table.state),
  ],
);
