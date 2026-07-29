import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { trips } from "./trips";
import { reasonCodes } from "./reason-codes";
import { users } from "./users";
import { exceptionResponsibleParty, exceptionSeverity, exceptionStatus } from "./enums";

/**
 * Feature 007 — exceptions (PRD §14.1, EXC-002). 1:1 with the PRD fields + the spec's `owner` (FR-008).
 * `severity`/`responsible_party` are NOT NULL (reason-code defaults pre-fill, but the stored value is
 * explicit). Category is DERIVED from `reason_codes.category` (R1) — no stored `category` column;
 * attachments are deferred to 008 — no column now. Status lifecycle is code-owned
 * (`canTransitionException`): legality checked pre-tx, then a guarded UPDATE inside the tx. Mutable
 * (status/owner/closure) → NO REVOKE; a recurrence is a NEW exception (append-only ethos, FR-009).
 */
export const exceptions = pgTable(
  "exceptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id),
    reasonCodeId: uuid("reason_code_id")
      .notNull()
      .references(() => reasonCodes.id),
    severity: exceptionSeverity("severity").notNull(),
    status: exceptionStatus("status").notNull().default("open"),
    responsibleParty: exceptionResponsibleParty("responsible_party").notNull(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id),
    description: text("description").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    closureNotes: text("closure_notes"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("exceptions_trip_idx").on(table.tripId),
    index("exceptions_status_idx").on(table.status),
    index("exceptions_severity_idx").on(table.severity),
    index("exceptions_owner_idx").on(table.ownerUserId),
    index("exceptions_reason_idx").on(table.reasonCodeId),
    index("exceptions_opened_idx").on(table.openedAt.desc()),
  ],
);
