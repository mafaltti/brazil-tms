import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Immutable, append-only record of a critical action (AUTH-005, FR-017–FR-020a).
 * No `updated_at`/`deleted_at`; the app exposes only insert + select. Append-only hardening
 * (`REVOKE UPDATE, DELETE ... FROM PUBLIC`) is added in the migration (data-model.md).
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    // Typed as `AuditAction` in app code; stored as text (extended per feature).
    action: text("action").notNull(),
    // jsonb snapshots of the relevant fields only (not whole rows). null on create/disable.
    previousValue: jsonb("previous_value"),
    newValue: jsonb("new_value"),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    reason: text("reason"),
  },
  (table) => [
    index("audit_logs_entity_idx").on(table.entityType, table.entityId),
    index("audit_logs_actor_idx").on(table.actorUserId),
    index("audit_logs_created_idx").on(table.createdAt.desc()),
  ],
);
