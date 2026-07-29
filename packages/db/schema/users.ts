import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgSchema,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { appRole } from "./enums";

/**
 * `auth.users` is owned by GoTrue — declared here ONLY so we can reference it for the FK.
 * It is NOT created or migrated by us (drizzle.config schemaFilter is ["public"]).
 */
const authSchema = pgSchema("auth");
export const authUsers = authSchema.table("users", {
  id: uuid("id").primaryKey(),
});

/**
 * Application profile + role binding (data-model.md). `id` mirrors `auth.users.id` (1:1, no
 * surrogate key). No hard delete — disabling sets `status='disabled'` (Constitution III).
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id")
      .primaryKey()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    role: appRole("role").notNull(),
    // 'pending' | 'active' | 'disabled' — enforced by the CHECK below and the shared Zod schemas.
    status: text("status").notNull(),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("users_role_idx").on(table.role),
    check("users_status_check", sql`${table.status} in ('pending', 'active', 'disabled')`),
  ],
);
