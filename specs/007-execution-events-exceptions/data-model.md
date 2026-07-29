# Phase 1 — Data Model: Execution Events, Exceptions, SLA Risk, and In-App Alerts

**Feature**: 007-execution-events-exceptions · **Date**: 2026-05-31 · **Spec**: [spec.md](./spec.md) · **Research**: [research.md](./research.md)

> Authoritative DDL is the committed `drizzle-kit generate` output under `packages/db/migrations/0006_*.sql`. The blocks below are the design sketch the schema files (`packages/db/schema/{reason-codes,exceptions,customer-sla-rules,alerts}.ts`) plus the `trips`/`trip-events` ALTERs produce. **Four new tables; three new pgEnums; `alert_case`/`alert_state`/`reason_codes.category`/`sla_status` are CHECK-constrained text (NOT enums); two `trips` columns (one ALTER + one new `text[]`); one `trip_events` FK activation + ONE new `trip_event_type` member (`note`); no new permission key, package, or worker process.**

The five locked decisions (Clarifications 2026-05-31c) this model encodes verbatim:
- **D1** — trigger→state map: a missed planned **origin/destination arrival window ⇒ Late**; missing assignment / missed confirmation / delayed loading / delayed departure / open high-severity exception **⇒ At Risk**; none ⇒ **On Track**; **Breached is unreachable in MVP** (needs a customer threshold, §29 Input #2).
- **D2** — multi-trigger precedence: **worst-state-wins** (On Track < At Risk < Late < Breached); `sla_reasons` retains **all** fired triggers.
- **D3** — alert uniqueness scope is **active OR acknowledged** (a dismissed-but-true alert is not re-spammed); the worker auto-resolves on clear; a later recurrence is a fresh row.
- **D4** — `trips.sla_status` stays **`text`** (validated to four values via Zod + CHECK, **no new enum**); add a sibling **`sla_reasons text[]`**; both written atomically.
- **D5** — optional **Loading/Unloading** sub-states are recordable via the existing **`status_change`** event type — **no** new `trip_event_type` member for them. (The single vocabulary extension is `note`, R6 — free-form events.)

---

## 1. New enums (`CREATE TYPE`) vs CHECK text

Three new pgEnums in `packages/db/schema/enums.ts` (the codebase convention — `pgEnum` for fixed sets referenced by domain logic / the evaluator; `text + CHECK` for business-mutable value sets, cf. `cancellation_options.kind`):

```sql
CREATE TYPE "exception_status"            AS ENUM ('open', 'monitoring', 'resolved', 'cancelled');
CREATE TYPE "exception_severity"          AS ENUM ('low', 'medium', 'high');           -- 'high' is the SLA/alert trigger
CREATE TYPE "exception_responsible_party" AS ENUM (
  'customer_caused', 'brazil_transports_caused', 'carrier_caused', 'force_majeure', 'unknown'  -- 5-value; adds force_majeure vs 003's 4
);
```

```ts
// packages/db/schema/enums.ts (append, after the 003 enums)
export const exceptionStatus = pgEnum("exception_status", [
  "open", "monitoring", "resolved", "cancelled",
]);
export const exceptionSeverity = pgEnum("exception_severity", ["low", "medium", "high"]);
export const exceptionResponsibleParty = pgEnum("exception_responsible_party", [
  "customer_caused", "brazil_transports_caused", "carrier_caused", "force_majeure", "unknown",
]);
```

**CHECK-constrained text (NOT enums)** — chosen so the value set can evolve without a `CREATE TYPE` migration (R0):
- `reason_codes.category` — 12 values, filter/display metadata, business-mutable code rows (mirrors `cancellation_options.kind`).
- `alerts.alert_case` — 8 values incl. the 2 deferred (`completed_missing_documents`, `billing_blocked_missing_proof`) that 008/009 wire with no type migration.
- `alerts.state` — `active | acknowledged | resolved` (keeps the partial-unique predicate readable).
- `trips.sla_status` — kept as 003's existing `text` column; validated to four values via Zod + a CHECK (D4 — no new enum).

**No new enum** for `sla_status`, `sla_reasons` members, `alert_case`, `alert_state`, or `reason_code_category` (R0/R5). **No** `gps`/`driver_input` added to `trip_event_source` (out of scope §20.2 — YAGNI). The single `trip_event_type` extension is `note` (R6, §3.6 below).

---

## 2. New table — `reason_codes` (PRD §14.1, EXC-004)

Config table mirroring 003's `cancellation_options` convention (business-mutable value set → `text + CHECK` for `category` + config rows, NOT a `pgEnum`).

```sql
CREATE TABLE "reason_codes" (
  "id"                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"                      text NOT NULL UNIQUE,
  "category"                  text NOT NULL,
  "label_pt"                  text NOT NULL,
  "default_severity"          "exception_severity" NOT NULL,
  "default_responsible_party" "exception_responsible_party" NOT NULL,
  "active"                    boolean NOT NULL DEFAULT true,
  "sort_order"                integer NOT NULL DEFAULT 0,
  "created_at"                timestamptz NOT NULL DEFAULT now(),
  "updated_at"                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "reason_codes_category_ck" CHECK ("category" IN (
    'delay', 'no_show', 'breakdown', 'driver_issue', 'customer_delay', 'loading_delay',
    'unloading_delay', 'documentation', 'accident', 'route_deviation', 'cancellation', 'other'
  ))
);
```

**Drizzle (`packages/db/schema/reason-codes.ts`)** — mirrors `cancellation-options.ts` (`check`, `text`, enum columns, `.defaultNow()`):

```ts
export const reasonCodes = pgTable(
  "reason_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    category: text("category").notNull(),
    labelPt: text("label_pt").notNull(),
    defaultSeverity: exceptionSeverity("default_severity").notNull(),
    defaultResponsibleParty: exceptionResponsibleParty("default_responsible_party").notNull(),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "reason_codes_category_ck",
      sql`${table.category} IN ('delay','no_show','breakdown','driver_issue','customer_delay','loading_delay','unloading_delay','documentation','accident','route_deviation','cancellation','other')`,
    ),
  ],
);
```

**Rules / invariants**
- `category` is one of the **12 EXC-004 values** (CHECK), the single source the exception category filter joins through (`exceptions.reason_code_id → reason_codes.category`); category is **derived, never stored on `exceptions`** (R1, Constitution III).
- `default_severity` / `default_responsible_party` ARE enums (they reference the fixed exception scales); they **pre-fill** create-exception inputs and remain editable (FR-010, EXC-004).
- Seeded as **labeled scaffolding** (Constitution II): one default row per category with a sensible severity/responsible-party — explicitly NOT final business sign-off (mirrors 003's `cancellation_options` gap, Blocked-item #5). Unlike `cancellation_options` (which seeds zero `reason` rows and fails closed), 007 seeds the categories so the Exception flow is demonstrable end-to-end at MVP.
- One configurable set, **not per-customer code** (Constitution V). Distinct from 003's `cancellation_options` (exceptions ≠ cancellations).
- **Mutable** (admin edits) → **NO REVOKE** (not append-only).

---

## 3. New table — `exceptions` (PRD §14.1, EXC-002)

```sql
CREATE TABLE "exceptions" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "trip_id"             uuid NOT NULL REFERENCES "trips"("id"),
  "reason_code_id"      uuid NOT NULL REFERENCES "reason_codes"("id"),
  "severity"            "exception_severity" NOT NULL,
  "status"              "exception_status" NOT NULL DEFAULT 'open',
  "responsible_party"   "exception_responsible_party" NOT NULL,
  "owner_user_id"       uuid NOT NULL REFERENCES "users"("id"),
  "description"         text NOT NULL,
  "opened_at"           timestamptz NOT NULL DEFAULT now(),
  "resolved_at"         timestamptz,
  "closure_notes"       text,
  "created_by_user_id"  uuid NOT NULL REFERENCES "users"("id"),
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "exceptions_trip_idx"     ON "exceptions" ("trip_id");
CREATE INDEX "exceptions_status_idx"   ON "exceptions" ("status");
CREATE INDEX "exceptions_severity_idx" ON "exceptions" ("severity");
CREATE INDEX "exceptions_owner_idx"    ON "exceptions" ("owner_user_id");
CREATE INDEX "exceptions_reason_idx"   ON "exceptions" ("reason_code_id");
CREATE INDEX "exceptions_opened_idx"   ON "exceptions" ("opened_at" DESC);
```

**Drizzle (`packages/db/schema/exceptions.ts`)** — mirrors `trips.ts`/`trip-assignments.ts` (inline FKs, `(table) => [ … ]` index array):

```ts
export const exceptions = pgTable(
  "exceptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id").notNull().references(() => trips.id),
    reasonCodeId: uuid("reason_code_id").notNull().references(() => reasonCodes.id),
    severity: exceptionSeverity("severity").notNull(),
    status: exceptionStatus("status").notNull().default("open"),
    responsibleParty: exceptionResponsibleParty("responsible_party").notNull(),
    ownerUserId: uuid("owner_user_id").notNull().references(() => users.id),
    description: text("description").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    closureNotes: text("closure_notes"),
    createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
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
```

**Rules / invariants**
- **1:1 with PRD §14.1's fields** plus the spec's `owner` addition (FR-008). `severity`/`responsible_party` are **not null** (every exception has both — reason-code defaults pre-fill but the stored value is explicit).
- **`owner_user_id` is NOT NULL** — defaults to the creating actor, reassignable to any internal user (FR-008). `created_by_user_id` is the immutable creator.
- **Category is derived, NOT stored** — read from the linked `reason_codes.category` (R1, Constitution III single-source; the Exception Management category filter joins through `reason_code_id`).
- **Attachments deferred to 008** — no column added now (Assumption 7, YAGNI).
- **Status lifecycle** is code-owned (`canTransitionException`, §6) — legality is checked pre-tx, then a guarded conditional UPDATE inside the transaction (`WHERE status = expectedFromStatus`; 0 rows ⇒ `STALE_EXCEPTION`); **Resolved/Cancelled are terminal — no reopen** (FR-009).
- Resolution sets `resolved_at` and requires `closure_notes`.
- **Mutable** (status, owner, closure) → **NO REVOKE** (not append-only; like `trip_assignments`). Audit + lifecycle give reconstructability; a recurrence is a **new** exception (append-only ethos, FR-009).
- Indexes back the FR-013 Exception Management filters (severity / customer-via-trip / lane-via-trip / reason / owner / age=`opened_at`).

---

## 4. New table — `customer_sla_rules` (PRD §14.1, CUST-005)

```sql
CREATE TABLE "customer_sla_rules" (
  "id"                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "customer_id"                   uuid NOT NULL REFERENCES "customers"("id"),
  "lane_id"                       uuid REFERENCES "lanes"("id"),
  "vehicle_type"                  "vehicle_type",
  "pickup_tolerance_minutes"      integer NOT NULL,
  "delivery_tolerance_minutes"    integer NOT NULL,
  "confirmation_cutoff_minutes"   integer NOT NULL,   -- lead time before pickup
  "at_risk_warning_minutes"       integer NOT NULL,   -- warning window
  "effective_start"               timestamptz,
  "effective_end"                 timestamptz,
  "active"                        boolean NOT NULL DEFAULT true,
  "created_at"                    timestamptz NOT NULL DEFAULT now(),
  "updated_at"                    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "customer_sla_rules_customer_idx" ON "customer_sla_rules" ("customer_id");
CREATE INDEX "customer_sla_rules_scope_idx"    ON "customer_sla_rules" ("customer_id", "lane_id", "vehicle_type");
```

**Drizzle (`packages/db/schema/customer-sla-rules.ts`)** — reuses the existing `vehicleType` enum (no new enum):

```ts
export const customerSlaRules = pgTable(
  "customer_sla_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id").notNull().references(() => customers.id),
    laneId: uuid("lane_id").references(() => lanes.id),
    vehicleType: vehicleType("vehicle_type"),
    pickupToleranceMinutes: integer("pickup_tolerance_minutes").notNull(),
    deliveryToleranceMinutes: integer("delivery_tolerance_minutes").notNull(),
    confirmationCutoffMinutes: integer("confirmation_cutoff_minutes").notNull(),
    atRiskWarningMinutes: integer("at_risk_warning_minutes").notNull(),
    effectiveStart: timestamp("effective_start", { withTimezone: true }),
    effectiveEnd: timestamp("effective_end", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("customer_sla_rules_customer_idx").on(table.customerId),
    index("customer_sla_rules_scope_idx").on(table.customerId, table.laneId, table.vehicleType),
  ],
);
```

**Rules / invariants**
- **Single-applicable-rule precedence is resolved in the evaluator's query — NOT a DB constraint** (R3): `WHERE customer_id = ? AND active AND (effective window covers the trip's pickup) AND (lane_id = trip.lane_id OR lane_id IS NULL) AND (vehicle_type = trip.planned_vehicle_type OR vehicle_type IS NULL)` `ORDER BY (lane_id IS NOT NULL) DESC, (vehicle_type IS NOT NULL) DESC, effective_start DESC NULLS LAST LIMIT 1`. Precedence is **lane > vehicle-type > customer-default, tie-break latest `effective_start`** (spec edge case). **No exclusion / `btree_gist` constraint** — gated low-volume human-administered data; overlap is disambiguated by the precedence, so a constraint is YAGNI and would reject legitimate overlapping scopes.
- **Absence of any matching row ⇒ company defaults (`DEFAULT_SLA_POLICY`) + that customer's SLA sign-off reported blocked** (FR-022, SC-008). Never silently signed off.
- Tolerances/cutoffs stored as **minutes (integer)** for unambiguous Luxon arithmetic in UTC.
- **Per-customer commercial config** → administered via the reused `manage_commercial_data` key (R12). **No `configure_sla` key.**
- **Mutable** (rule edits) → **NO REVOKE**.

---

## 5. New table — `alerts` (PRD §17, FR-023/024)

```sql
CREATE TABLE "alerts" (
  "id"                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "trip_id"                 uuid NOT NULL REFERENCES "trips"("id"),
  "alert_case"              text NOT NULL,
  "severity"                "exception_severity" NOT NULL,   -- reuse the same scale (KISS)
  "state"                   text NOT NULL DEFAULT 'active',
  "created_at"              timestamptz NOT NULL DEFAULT now(),
  "acknowledged_by_user_id" uuid REFERENCES "users"("id"),
  "acknowledged_at"         timestamptz,
  "auto_resolved_at"        timestamptz,
  "updated_at"              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "alerts_case_ck" CHECK ("alert_case" IN (
    'unassigned_within_window', 'unconfirmed_within_window', 'missed_origin_arrival',
    'missed_departure', 'missed_destination_arrival', 'high_severity_exception',
    'completed_missing_documents', 'billing_blocked_missing_proof'  -- last two deferred to 008/009
  )),
  CONSTRAINT "alerts_state_ck" CHECK ("state" IN ('active', 'acknowledged', 'resolved'))
);

-- D3: at most one NOT-YET-CLEARED alert per (trip, case) — scope is active OR acknowledged.
CREATE UNIQUE INDEX "alerts_trip_case_open_uq"
  ON "alerts" ("trip_id", "alert_case") WHERE "state" IN ('active', 'acknowledged');

CREATE INDEX "alerts_trip_idx"  ON "alerts" ("trip_id");
CREATE INDEX "alerts_state_idx" ON "alerts" ("state");
```

**Drizzle (`packages/db/schema/alerts.ts`)** — the partial-unique on a `state IN (...)` predicate mirrors 006's `is_current` partial-unique pattern:

```ts
export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id").notNull().references(() => trips.id),
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
```

**Rules / invariants**
- **D3 uniqueness** — at most one `active`-OR-`acknowledged` row per `(trip_id, alert_case)` via the partial-unique index; a `resolved` row falls outside the predicate, so a later recurrence inserts a fresh row.
- **Idempotent generation** = `INSERT ... ON CONFLICT (the partial-unique target) DO NOTHING` (safe for the concurrent synchronous-BFF + worker-sweep paths, FR-024).
- **Auto-resolution** = `UPDATE alerts SET state='resolved', auto_resolved_at=now() WHERE trip_id=? AND alert_case=? AND state IN ('active','acknowledged')` when the condition clears.
- **Acknowledgement** = `state → acknowledged`, sets `acknowledged_by_user_id`/`acknowledged_at`; an acknowledged-but-still-true alert is NOT regenerated (D3).
- `alert_case` is **CHECK text** including the 2 deferred cases (008/009 wire them with no `CREATE TYPE`); 007 generates only the **6 in-scope** cases (FR-026).
- `severity` reuses `exception_severity` (no separate alert-severity scale — KISS).
- **Mutable** (acknowledge/resolve) → **NO REVOKE**. Acknowledgement is tracked on the row itself, NOT as an `AuditAction` (R13 — view triage, not a domain mutation).
- **In-app only** — no external channel column or delivery (FR-025).

---

## 6. `trips` ALTER — compute `sla_status`, add `sla_reasons text[]` (D4, FR-014)

Keep `trips.sla_status` as **`text`** (003's existing nullable placeholder column type — unchanged) and add a CHECK; add a new sibling `sla_reasons text[]` (the **first** array column in the schema).

```sql
ALTER TABLE "trips" ADD COLUMN "sla_reasons" text[];
ALTER TABLE "trips" ADD CONSTRAINT "trips_sla_status_ck"
  CHECK ("sla_status" IS NULL OR "sla_status" IN ('on_track', 'at_risk', 'late', 'breached'));
```

**Drizzle (`packages/db/schema/trips.ts`, EXTEND)** — add the array column + the CHECK to the `(table) => [ … ]` array:

```ts
// columns (after slaStatus, which stays `text("sla_status")` — type UNCHANGED, D4):
slaReasons: text("sla_reasons").array(),       // first .array() column — verify drizzle-kit emits `text[]`
// table extras:
check(
  "trips_sla_status_ck",
  sql`${table.slaStatus} IS NULL OR ${table.slaStatus} IN ('on_track','at_risk','late','breached')`,
),
```

**Rules / invariants**
- **No `sla_status` enum** (D4) — validated to the four values via Zod + the CHECK; 003's column type is unchanged.
- `sla_status` + `sla_reasons` are written **atomically** by `recomputeTripSla` in the same `tx.update(trips).set({ slaStatus, slaReasons, updatedAt })` (FR-014, §9.2).
- `sla_status` = the **most severe** (worst-state-wins, D2) of all fired triggers; `sla_reasons` retains **all** fired reasons. **Breached is never produced in MVP** (D1).
- `sla_reasons text[]` is the **first** `.array()` column in `packages/db` (RECON: none exist) — **hand-verify the generated 0006 migration emits `text[]`**. When querying it, honor the array-expansion gotcha (MEMORY `drizzle_sql_array_expansion`: use `IN ${ids}` tuple form, never `= ANY(${arr}::uuid[])`).

---

## 7. `trip_events` ALTER — wire `exception_id` FK + add `trip_event_type` member `note` (D5, R6, FR-003/004)

```sql
-- The forward-hook FK 003 left for 007 to wire (the `exception_id` column already exists).
ALTER TABLE "trip_events" ADD CONSTRAINT "trip_events_exception_id_exceptions_id_fk"
  FOREIGN KEY ("exception_id") REFERENCES "exceptions"("id");

-- The ONE event-vocabulary extension (free-form notes) — D5: NOT for Loading/Unloading.
ALTER TYPE "trip_event_type" ADD VALUE 'note';
```

**Schema edits**
- `packages/db/schema/trip-events.ts` (EXTEND): add `.references(() => exceptions.id)` to the existing `exceptionId` column (drizzle-kit emits the FK once the `.references()` is added — **hand-verify** this cross-feature activation on a pre-existing column).
- `packages/db/schema/enums.ts` (EXTEND `tripEventType`): append `"note"` to the member list (mirrors `@brazil-tms/shared` `TRIP_EVENT_TYPES`, kept in lockstep).

**Rules / invariants**
- **`note` is the ONLY new event type** (R6) — free-form events (FR-004, EVT-003) are not status changes and have no fitting existing member. Manual milestone/note events use `source='operator_manual'`.
- **Loading/Unloading add NO event-type member** (D5) — recorded as `status_change` events (`status_after = 'loading'`/`'unloading'`).
- **No `gps`/`driver_input`** added to `trip_event_source` (out of scope §20.2 — YAGNI).
- `trip_events` **stays append-only** — keeps its existing `REVOKE UPDATE, DELETE` (insert + select only); 007 only INSERTs and reads (FR-002, Constitution III). The `exception_id`-carrying row is a `note` or `status_change` event — there is no `exception_logged` event type.
- **`ALTER TYPE ... ADD VALUE` cannot run inside the same transaction as its first use** (Postgres) — drizzle-kit emits it as its own statement; verify ordering in the 0006 migration.

---

## 8. Reused tables (read-only / driven, not redefined)

| Table | Used for | Key columns |
|-------|----------|-------------|
| `trips` (003) | SLA target; milestone status transitions via 003's service; planned-vs-actual source; ALTER'd here for `sla_status`/`sla_reasons` (§6) | `current_status`, `planned_pickup_window_start/_end`, `planned_delivery_window_start/_end`, `planned_vehicle_type`, `customer_id`, `lane_id`, `sla_status`, `sla_reasons` |
| `trip_events` (003) | milestone `status_change` rows (driven by `transitionTripStatus`) + the new `note` rows; the chronological timeline; ALTER'd here to wire `exception_id` FK (§7) | `event_type` (reuse `status_change`, add `note`), `status_before/after`, `event_timestamp`, `source`, `actor_user_id`, `location_id`, `notes`, `exception_id` |
| `customers` (002) | per-customer SLA rules + exception customer filter | `id`, `name`, `archived_at` |
| `lanes` (002) | optional SLA-rule scope | `id`, `customer_id` |
| `users` (001) | exception owner/creator, alert acknowledger | `id` |
| `audit_logs` (001) | append-only exception/note/SLA-rule audit | `entity_type`/`entity_id`, `action`, `previous_value`/`new_value`, `actor_user_id`, `reason` |
| `trip_assignments` (006) | read-only `assignmentPresent` / `confirmed_at` for missing-assignment + missed-confirmation risk (FR-017) | `is_current`, `confirmed_at` |
| `drivers`/`vehicles`/`carriers` (002) | board/detail display names (reused board joins) | `name`/`plate`/`name` |

The 003 status machine, `transitionTripStatus` service, master data, the 006 assignment/confirmed-at state, and the 005 board/detail/dashboard read models are **reused, never redefined** (Constitution I/III). Reused enums (`trip_status`, `vehicle_type`, `trip_event_source`, `resource_status`) already cover 007.

---

## 9. Domain logic (shared, pure)

### 9.1 SLA-risk evaluator — `packages/shared/src/domain/sla-risk.ts` (NEW)

Pure, DB-free; the **single SLA authority** the BFF and worker both call, the UI never computes (FR-014, Constitution III, STACK §3.13 names it a Vitest focus — mirrors 006's `assignment-eligibility.ts`).

```ts
export const SLA_STATUSES = ["on_track", "at_risk", "late", "breached"] as const;  // severity index = ordinal
export type SlaStatus = (typeof SLA_STATUSES)[number];

export const SLA_REASONS = [
  "missing_assignment", "missed_confirmation", "delayed_origin_arrival", "delayed_loading",
  "delayed_departure", "delayed_destination_arrival", "open_high_severity_exception",
] as const;
export type SlaReason = (typeof SLA_REASONS)[number];

/** All the per-trip facts the evaluator needs — gathered DB-side, then evaluated purely. */
export interface SlaContext {
  now: Date;
  currentStatus: TripStatus;
  plannedPickupWindowStart: Date | null;
  plannedPickupWindowEnd: Date | null;
  plannedDeliveryWindowStart: Date | null;
  plannedDeliveryWindowEnd: Date | null;
  confirmedAt: Date | null;
  assignmentPresent: boolean;                 // current trip_assignments row exists (006, read-only)
  openHighSeverityExceptionCount: number;     // exceptions WHERE status IN ('open','monitoring') AND severity='high'
  currentStatusEnteredAt: Date | null;        // latest status_change event ts for the current status (time-in-status)
}

/** The four labeled-configurable default magnitudes; a customer_sla_rules row overrides them. */
export interface SlaPolicy {
  atRiskWarningMinutes: number;     // 60
  pickupToleranceMinutes: number;   // 0  (window edge is the cutoff)
  deliveryToleranceMinutes: number; // 0
  confirmationCutoffMinutes: number;// 120 (lead time before pickup)
  timeInStatusThresholdMinutes: number; // 120 (loading/departure)
}

export const DEFAULT_SLA_POLICY: SlaPolicy = {
  atRiskWarningMinutes: 60,
  pickupToleranceMinutes: 0,
  deliveryToleranceMinutes: 0,
  confirmationCutoffMinutes: 120,
  timeInStatusThresholdMinutes: 120,
};

export function evaluateSlaRisk(
  ctx: SlaContext,
  policy: SlaPolicy = DEFAULT_SLA_POLICY,
): { status: SlaStatus; reasons: SlaReason[] };
```

**Encoded rules (D1/D2, FR-015..019)**
- **Terminal/cancelled trips short-circuit** to no evaluation (Edge Case) — `!isActiveStatus(currentStatus)` returns `{ status: existing-or-unchanged, reasons: [] }` (the caller skips the recompute).
- **D1 trigger→state map**: `delayed_origin_arrival` / `delayed_destination_arrival` (missed planned arrival window ± tolerance) ⇒ **Late**; `missing_assignment` / `missed_confirmation` / `delayed_loading` / `delayed_departure` / `open_high_severity_exception` ⇒ **At Risk**; none ⇒ **On Track**.
- **D2 worst-state-wins**: `status` = max-severity (by `SLA_STATUSES` ordinal) over all fired reasons' states; `reasons` retains **all** fired triggers.
- **Breached** value exists but **no MVP trigger maps to it** (needs a customer threshold, §29 Input #2).
- **No-planned-window branch** (FR-016): when a window is null, skip its window-based risk leg but still evaluate assignment / confirmation / time-in-status / exception.
- **Time-in-status** (FR-018): `delayed_loading`/`delayed_departure` measured from `currentStatusEnteredAt` vs `timeInStatusThresholdMinutes` (per-milestone planned times unavailable, §29 Input #2; D5 makes Loading/Unloading recordable, so this is reachable).
- `missing_assignment` reads `assignmentPresent`; `missed_confirmation` reads `confirmedAt` vs `plannedPickupWindowStart - confirmationCutoffMinutes` (006 state, read-only, FR-017).

Barrel: add `export * from "./domain/sla-risk"` to `packages/shared/src/index.ts` after `./domain/assignment-eligibility`.

### 9.2 Exception lifecycle + vocabulary — `packages/shared/src/domain/exceptions.ts` (NEW)

Pure helper; the legal map is tiny and code-owned like `TRANSITIONS` in `trip-status.ts` (R8).

```ts
export const EXCEPTION_STATUSES = ["open", "monitoring", "resolved", "cancelled"] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];

export const EXCEPTION_SEVERITIES = ["low", "medium", "high"] as const;  // 'high' = SLA/alert trigger
export type ExceptionSeverity = (typeof EXCEPTION_SEVERITIES)[number];

/** 5-value set — adds `force_majeure`, distinct from 003's 4-value cancellation_responsible_party. */
export const EXCEPTION_RESPONSIBLE_PARTIES = [
  "customer_caused", "brazil_transports_caused", "carrier_caused", "force_majeure", "unknown",
] as const;
export type ExceptionResponsibleParty = (typeof EXCEPTION_RESPONSIBLE_PARTIES)[number];

/** The 12 EXC-004 categories — mirrors the reason_codes.category CHECK, kept in lockstep. */
export const REASON_CODE_CATEGORIES = [
  "delay", "no_show", "breakdown", "driver_issue", "customer_delay", "loading_delay",
  "unloading_delay", "documentation", "accident", "route_deviation", "cancellation", "other",
] as const;
export type ReasonCodeCategory = (typeof REASON_CODE_CATEGORIES)[number];

/** The legal exception transition map (FR-009): Open↔Monitoring; →Resolved/Cancelled terminal. */
const EXCEPTION_TRANSITIONS: Record<ExceptionStatus, readonly ExceptionStatus[]> = {
  open: ["monitoring", "resolved", "cancelled"],
  monitoring: ["open", "resolved", "cancelled"],
  resolved: [],     // terminal — no reopen
  cancelled: [],    // terminal — no reopen
};

export function canTransitionException(from: ExceptionStatus, to: ExceptionStatus): boolean {
  return EXCEPTION_TRANSITIONS[from]?.includes(to) ?? false;
}
```

**Rules / invariants**
- Mirrors `domain/trip-status.ts` (`as const` arrays + a `Record<…, readonly …[]>` map + a pure predicate). The DB pgEnums (§1) are kept in lockstep with these arrays (PR review enforces, like 003).
- **Resolved/Cancelled terminal — no reopen** (FR-009); recurrence = new exception.
- The 5-value `EXCEPTION_RESPONSIBLE_PARTIES` is its **own** set, never reusing `CANCELLATION_RESPONSIBLE_PARTIES` (which lacks `force_majeure` — FR-011).
- Barrel: `export * from "./domain/exceptions"` after `./domain/sla-risk`.

### 9.3 SLA job contract — `packages/shared/src/sla/jobs.ts` (NEW, sibling of `import/jobs.ts`)

Pure (no pg-boss import) — the job name + payload the BFF (never) and worker share.

```ts
export const SLA_JOBS = { slaSweep: "sla.sweep" } as const;
export type SlaJobName = (typeof SLA_JOBS)[keyof typeof SLA_JOBS];
export interface SlaSweepPayload { /* empty — scheduled cron has no per-run input */ }
export interface SlaJobPayloads { "sla.sweep": SlaSweepPayload; }
```

Barrel: `export * from "./sla/jobs"`. (Mirrors `import/jobs.ts`; worker `lib/queue.ts` would merge `SLA_JOBS` into its `JOB`/`JobPayloads` surface.)

### 9.4 Audit actions — `packages/shared/src/audit/actions.ts` (EXTEND)

Add to **both** the `AuditAction` union **and** `ALL_AUDIT_ACTIONS` (kept in lockstep — `satisfies` + the i18n guard test enforce it):

```
"exception.create", "exception.update", "exception.resolve", "exception.cancel",
"trip.note", "sla_rule.create", "sla_rule.update"
```

- **Milestone/status changes reuse the existing `trip.status_change`** (no new action — driven through `transitionTripStatus`).
- **SLA recompute is NOT audited** (derived projection, not a user action — avoids 5-min-sweep audit spam; the triggering mutation is already audited).
- **Alert generate/acknowledge are NOT in `AuditAction`** (worker operational notices / view triage; tracked on the `alerts` row via `acknowledged_by_user_id`/`acknowledged_at`).
- i18n (R13): each new action needs labels in **both** `Trips.auditActions` (nested — e.g. `auditActions.exception.create`, `auditActions.trip.note`) **and** flat `AuditActions` (`exception_create`, `exception_update`, `exception_resolve`, `exception_cancel`, `trip_note`, `sla_rule_create`, `sla_rule_update`). **Never a dotted key** (next-intl `INVALID_KEY`, MEMORY).

---

## 10. Zod schemas (shared)

New files in `packages/shared/src/schemas/` (each gets an `export *` in `src/index.ts` after `trip-board`), mirroring the `z.enum(ARRAY, { message })` + `uuid()`/`optionalUuid()` conventions of `trip-assignment.ts`/`trip.ts`:

- **`trip-event.ts`** — `addTripNoteSchema` (`notes` `z.string().trim().min(1).max(2000)`, optional `locationId`/`exceptionId` (`optionalUuid`), optional `eventTimestamp` `z.coerce.date().optional()`). Milestone recording reuses 003's `transitionTripSchema` (`./trip`) — not redefined.
- **`exception.ts`** — `createExceptionSchema` (`reasonCodeId` uuid, `severity` `z.enum(EXCEPTION_SEVERITIES)`, `responsibleParty` `z.enum(EXCEPTION_RESPONSIBLE_PARTIES)`, optional `ownerUserId` uuid (defaults to actor server-side), `description` ≤2000); `updateExceptionSchema` (owner/severity/responsible-party/description edits — all optional, ≥1 present); `transitionExceptionSchema` (`expectedFromStatus`/`toStatus` `z.enum(EXCEPTION_STATUSES)`, `closureNotes` required when `toStatus='resolved'` via `superRefine`, ≤2000).
- **`customer-sla-rule.ts`** — `createSlaRuleSchema`/`updateSlaRuleSchema` (`customerId` uuid; the four minute fields `z.number().int().nonnegative()`; optional `laneId`/`vehicleType` (`vehicleTypeSchema`); optional `effectiveStart`/`effectiveEnd` `z.coerce.date()`).
- **`alert.ts`** — `acknowledgeAlertSchema` (minimal; the id comes from the route param).
- **`trip-board.ts`** (EXTEND) — add an `slaStatus` filter param (`oneOrMany(z.enum(SLA_STATUSES))`) and/or `atRisk` (`optParam(z.enum(["true","false"]))`) for the "At risk" view; add the key to `PARAM_KEYS`.

---

## 11. Service functions — `packages/db/src/trips/` (NEW + EXTEND)

All mirror `transitionTripStatus`/`assignTrip` EXACTLY: pre-tx legality (outside the tx, so a refused action changes NO state) → one `db.transaction` doing a guarded conditional UPDATE (0 rows ⇒ `Conflict`) + the row(s) + `writeAudit(tx, …)` → return `loadTripDetail(tx, tripId)`. All conflicts `throw new Conflict(CODE, "pt-BR message")`.

### 11.1 `exceptions.ts` (NEW)

```ts
export async function createException(tripId: string, input: CreateExceptionInput, actorUserId: string): Promise<TripDetail>;
//   resolve reason_code (active) → INVALID_REASON_CODE if unknown/inactive; reason-code defaults pre-fill
//   severity/responsible_party (overridable); owner defaults to actorUserId; INSERT 'open'; writeAudit exception.create;
//   then recomputeTripSla(tx, tripId) (open high-sev may flip risk) + synchronous high-sev alert (§5 ON CONFLICT DO NOTHING).
export async function updateException(exceptionId: string, input: UpdateExceptionInput, actorUserId: string): Promise<TripDetail>;
//   owner reassign / severity / responsible-party / description edits; writeAudit exception.update; recomputeTripSla.
export async function transitionException(exceptionId: string, input: TransitionExceptionInput, actorUserId: string): Promise<TripDetail>;
//   pre-tx canTransitionException(from,to) ⇒ ILLEGAL_EXCEPTION_TRANSITION; guarded UPDATE
//   WHERE status = expectedFromStatus (0 rows ⇒ STALE_EXCEPTION); on 'resolved' set resolved_at + require closure_notes;
//   writeAudit exception.resolve | exception.cancel | exception.update; recomputeTripSla (resolving a high-sev clears the trigger).
```

Conflict codes: `NOT_FOUND`, `INVALID_REASON_CODE`, `ILLEGAL_EXCEPTION_TRANSITION`, `STALE_EXCEPTION`.

### 11.2 `sla.ts` (NEW) — the single on-change recompute (R11)

```ts
export async function recomputeTripSla(tx: DB | Tx, tripId: string, actorUserId?: string): Promise<void>;
//   (1) load planned windows + current_status + currentStatusEnteredAt + assignmentPresent + confirmedAt (006) +
//       openHighSeverityExceptionCount; (2) resolve the applicable customer_sla_rules row (§4 ORDER BY … LIMIT 1) or
//       DEFAULT_SLA_POLICY; (3) evaluateSlaRisk(ctx, policy); (4) atomic tx.update(trips).set({ slaStatus, slaReasons, updatedAt }).
//   NOT separately audited (derived). Terminal/cancelled trips short-circuit (no write).
```

Called **synchronously inside the mutation tx** of every risk-affecting service: milestone (`transitionTripStatus` callers / `addTripNote`), exception create/update/transition, and (read-only-input) assignment/confirmation changes — giving immediate UI truth (FR-019). Per-trip concurrency with the worker uses `SELECT … FOR UPDATE` on the trip row inside each per-trip tx (last-writer-wins on identical deterministic evaluator inputs).

### 11.3 `trip-events.ts` (NEW) — free-form note (R9)

```ts
export async function addTripNote(tripId: string, input: AddTripNoteInput, actorUserId: string): Promise<TripDetail>;
//   INSERT trip_events { event_type:'note', source:'operator_manual', notes, locationId?, exceptionId?, eventTimestamp? } —
//   NO status change; writeAudit trip.note; recomputeTripSla; return loadTripDetail(tx, tripId).
```

### 11.4 Milestone recording — reuse `transitionTripStatus` (R9, FR-003)

Milestones drive the existing transitions `confirmed→at_origin→[loading]→loaded→in_transit→at_destination→[unloading]→unloaded→completed` (all legal `TRANSITIONS` edges; `loading`/`unloading` skippable) with `source:'operator_manual'`. The machine is **not** redefined. `transitionTripStatus` (or its 007 callers) gains a synchronous `recomputeTripSla` call after the transition commits-in-tx so risk flips immediately. Planned-vs-actual (FR-005) is derived in the read/UI layer (planned windows vs recorded milestone `event_timestamp`) — no new storage.

### 11.5 New `packages/db/src/index.ts` exports

`createException`, `updateException`, `transitionException` (from `./trips/exceptions`); `recomputeTripSla` (from `./trips/sla`); `addTripNote` (from `./trips/trip-events`); the SLA-rule + reason-code + alert reads (§12); and the four new schema tables via `export * from "../schema"` (already a barrel re-export).

---

## 12. Read-model extensions — `packages/db/src/trips/` (EXTEND, R14)

### `trip-dto.ts` / `loadTripDetail`
- Add `slaReasons: string[] | null` to `TripSummary` (mapped in `toTripSummary` from `row.slaReasons`).
- Add `exceptionId: string | null` to `TripEventDto` (surface the column 003 left unsurfaced).
- Add `exceptions: ExceptionDto[]` and `alerts: AlertDto[]` to `TripDetail`, loaded in the SAME `loadTripDetail` executor (so detail/mutation reloads carry them — single source, DRY). `ExceptionDto` joins `reason_codes` for `category`/`labelPt`. Timeline stays `desc(createdAt) limit 50`.

### `trips-read.ts`
- `TripBoardRow` already carries `slaStatus`; add `slaReasons: string[] | null` and ensure `slaStatus` is now **populated** (computed by §6/§9.2).
- `buildWhere` gains the `slaStatus`/`atRisk` board filter (`inArray(trips.currentStatus,…)`-style on `trips.slaStatus`).
- **`queryDashboardMetrics` fills the four remaining nulls**: `tripsAtRisk` (active trips with `sla_status IN ('at_risk','late','breached')`), `activeExceptions` (`exceptions WHERE status IN ('open','monitoring')`), `onTimePickupPct`/`onTimeArrivalPct` (recorded arrival events vs planned windows ± tolerance over the dashboard period). The dashboard `metric()` helper auto-flips placeholder→value with no component change.
- `getTripFilterOptions` / `TripFilterOptions` gains **reason-code** and **owner** option sources for the Exception Management filters (today only `customers`/`lanes`/fleet exist).
- New reads: `queryExceptions(filters)` (severity / customer / lane / reason / owner / age — the FR-013 Exception Management list); `queryReasonCodes()` (active reason-code list for the create form); `listAlerts()` / alert counts (active + acknowledged); `queryCustomerSlaRules()` / SLA-rule CRUD reads.

---

## 13. BFF endpoints (R12, FR-027) — ~12 routes

Route files under `apps/web/app/api/`, each `requireAuth → requirePermission → Zod parse → service → handleRouteError` (`params` is a Promise; `dynamic="force-dynamic"`; `{ item }`/`{ items }` bodies; `Conflict→409` with `findings` passthrough; `NOT_FOUND→404`).

| Endpoint | Method | Permission | Service / read |
|---|---|---|---|
| `/api/trips/[id]/status` (extend the existing transition route) | POST | `update_trip_status` | `transitionTripStatus` (milestone) + `recomputeTripSla` |
| `/api/trips/[id]/events` (free-form note) | POST | `update_trip_status` | `addTripNote` |
| `/api/trips/[id]/exceptions` | POST | `create_exceptions` | `createException` (+ synchronous high-sev alert + recompute) |
| `/api/exceptions/[id]` | PATCH | `resolve_exceptions` | `updateException` |
| `/api/exceptions/[id]/transition` | POST | `resolve_exceptions` | `transitionException` |
| `/api/exceptions` | GET | `view_all_trips` | `queryExceptions` (severity/customer/lane/reason/owner/age) |
| `/api/reason-codes` | GET | `view_all_trips` | `queryReasonCodes` (create form) |
| `/api/customer-sla-rules` | GET / POST | GET `view_all_trips`, POST `manage_commercial_data` | list / create |
| `/api/customer-sla-rules/[id]` | PATCH | `manage_commercial_data` | update |
| `/api/alerts` | GET | `view_all_trips` | active/acknowledged list + counts |
| `/api/alerts/[id]/acknowledge` | POST | `view_all_trips` | acknowledge (state → acknowledged) |
| `/api/trips`, `/api/trips/[id]`, `/api/dashboard/summary` | GET | `view_all_trips` | **extended** reads (§12) |

**No new permission key** (FR-027) — `update_trip_status`/`create_exceptions`/`resolve_exceptions` first-enforced; `manage_commercial_data` reused; reads + alert acknowledge stay on `view_all_trips` (acknowledge is view triage — no write key exists). Conflict codes reused (`NOT_FOUND`, `STALE_TRANSITION`, `ILLEGAL_TRANSITION`) + new `STALE_EXCEPTION`, `ILLEGAL_EXCEPTION_TRANSITION`, `INVALID_REASON_CODE`.

---

## 14. Worker — first scheduled job (R10, FR-019/023)

The **single existing `@brazil-tms/workers` process** + the existing pg-boss queue gain **ONE scheduled job** (the first ever) — `workers/jobs/sla-sweep/` (`index.ts` exporting `runSlaSweep(payload)` + `registerSlaSweep(boss)`, mirroring the import-job convention), registered with one line in `workers/jobs/index.ts`; the queue name added to `setupQueues`. Scheduled via pg-boss's built-in cron (`boss.schedule(SLA_JOBS.slaSweep, cron, {}, opts)`) — default **~5 min, configurable** via `SLA_SWEEP_CRON` (added to `workers/.env` + the docker-compose worker env). The job name/payload contract is the shared `sla/jobs.ts` (§9.3).

The sweep, over **active (non-terminal) trips only** (`ACTIVE_TRIP_STATUSES`), in **chunks** (≤200/batch): (a) `recomputeTripSla` per trip with **per-trip fault isolation** (try/catch — skip-and-continue, log, never abort); (b) **generate + auto-resolve alerts idempotently** (`ON CONFLICT DO NOTHING` for the 6 in-scope cases; conditional UPDATE for auto-resolve). Per-trip `SELECT … FOR UPDATE` makes it safe with the synchronous BFF recalc (R11). Observability: a per-sweep summary log (`duration_ms`, `evaluated`, `changed`, `alerts_created`, `alerts_resolved`, `errors`). **No new worker process** — the constitutionally pre-declared mechanism (built by 004) gains its first in-scope scheduled need.

---

## 15. State & lifecycle (reused, not redefined)

**Trip milestones reuse the 003 machine** (no new edge — 007 only triggers existing `TRANSITIONS`):

```
confirmed --at_origin-->        at_origin    (status_change; trip.status_change; recomputeTripSla)
at_origin --[loading]-->        loading      (optional sub-state; D5 status_change, no new event type)
at_origin/loading --loaded-->   loaded
loaded/at_origin --in_transit-->in_transit
in_transit --at_destination-->  at_destination
at_destination --[unloading]--> unloading    (optional sub-state; D5)
at_destination/unloading --unloaded--> unloaded
unloaded --completed-->         completed
```

**Exception lifecycle** (`domain/exceptions.ts`, FR-009 — Open↔Monitoring; →Resolved/Cancelled terminal):

```
open       --> monitoring | resolved | cancelled
monitoring --> open | resolved | cancelled
resolved   --> (terminal — no reopen)
cancelled  --> (terminal — no reopen)
```

**Alert lifecycle** (worker + BFF, D3): `active --acknowledge--> acknowledged`; `active|acknowledged --condition clears (worker)--> resolved (auto_resolved_at)`; a later recurrence inserts a fresh `active` row (the prior is `resolved`, outside the partial-unique predicate).

**SLA-risk** is a recomputed projection (never a hand-edited state) — `recomputeTripSla` writes `sla_status`/`sla_reasons` atomically on every relevant change + the worker sweep; worst-state-wins (D2); Breached unreachable in MVP (D1).

---

## 16. Migration `packages/db/migrations/0006_*.sql` (R15)

One drizzle migration (next sequential after `0005_conscious_kat_farrell.sql`; journal idx 0–5, so this is `0006`), generated by `drizzle-kit generate` from the new/edited schema files + the barrel `packages/db/schema/index.ts` (add `export * from "./reason-codes"`, `"./exceptions"`, `"./customer-sla-rules"`, `"./alerts"` after the 006 line) + `packages/db/src/index.ts` re-exports. Contents:

- `CREATE TYPE` × 3 — `exception_status`, `exception_severity`, `exception_responsible_party` (§1).
- `ALTER TYPE "trip_event_type" ADD VALUE 'note'` (own statement — not inside a tx with its first use; §7).
- `CREATE TABLE` × 4 — `reason_codes`, `exceptions`, `customer_sla_rules`, `alerts` with FKs, the `reason_codes_category_ck`/`alerts_case_ck`/`alerts_state_ck` CHECKs, all indexes incl. the `alerts_trip_case_open_uq` partial-unique.
- `ALTER TABLE trips ADD COLUMN sla_reasons text[]` + `ADD CONSTRAINT trips_sla_status_ck CHECK (...)` (§6).
- `ALTER TABLE trip_events ADD CONSTRAINT … FOREIGN KEY (exception_id) REFERENCES exceptions(id)` — the forward-hook FK activation (§7).
- **NO REVOKE** for `reason_codes`/`exceptions`/`customer_sla_rules`/`alerts` — they **mutate** (status/owner/closure, rule edits, acknowledge/resolve), like `trip_assignments` (not append-only). `trip_events` **keeps its existing REVOKE** (still append-only).
- `meta/_journal.json` + snapshots updated by the tool.

**Hand-edit / hand-verify needed** (the cases drizzle-kit has historically needed manual confirmation for):
1. The cross-feature `trip_events.exception_id` FK on a **pre-existing** column emits correctly.
2. `trips_sla_status_ck` CHECK on a **pre-existing** column emits.
3. `sla_reasons` emits as **`text[]`** (the **first** array column — no prior example in the schema).
4. The `alerts_trip_case_open_uq` partial-unique `WHERE state IN (...)` predicate emits.
5. `ALTER TYPE … ADD VALUE 'note'` is its **own** statement, ordered before any first use (Postgres cannot add an enum value and use it in the same transaction).
