import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Config-driven cancellation value sets (data-model §3; FR-021, R8, Constitution V). One table holds
 * BOTH value sets via a `kind` discriminator (`reason` | `billing_impact`) — a single table with a
 * discriminator, not two near-identical tables (Constitution I, ≥3 rule).
 *
 * These value sets are business-blocked: `cancelTrip` validates the submitted `reasonCode` /
 * `billingImpact` against the ACTIVE rows here, and FAILS with `CANCELLATION_NOT_CONFIGURED` when the
 * required `kind` has no active rows ("missing configuration → fail"). The seed leaves `reason` EMPTY
 * on purpose (production cancellation fails until business supplies codes) and seeds `billing_impact`
 * with the §19.5 examples as LABELED scaffolding (Constitution II) — not final sign-off.
 */
export const cancellationOptions = pgTable(
  "cancellation_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    code: text("code").notNull(),
    labelPt: text("label_pt").notNull(),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("cancellation_options_kind_ck", sql`${table.kind} IN ('reason', 'billing_impact')`),
    unique("cancellation_options_kind_code_uq").on(table.kind, table.code),
  ],
);
