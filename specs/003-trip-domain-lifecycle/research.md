# Phase 0 Research: Trip Domain, Status Machine, and Audit Semantics

**Feature**: 003-trip-domain-lifecycle | **Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)

All three `/speckit-clarify` decisions (single status enum; cancellation legal through `At Destination`;
documented-default critical-field set) are encoded in the spec, so there are **no open `NEEDS CLARIFICATION`
items**. This document records the design decisions (Decision / Rationale / Alternatives) that turn the
clarified spec into a buildable plan. Two business inputs (cancellation reason codes, billing-impact values)
remain **blocked**; they are scaffolded config-driven (R8), not invented.

## R0 — Build on features 001 and 002 (do not rebuild)

- **Decision**: Reuse, unchanged, the primitives 001/002 shipped: `requireAuth()` + `requirePermission(ctx,
  key)` (`apps/web/lib/auth/require-auth.ts`), the static permission catalog + `can()`
  (`packages/shared/src/auth/permissions.ts`), `writeAudit(tx, entry)` (`apps/web/lib/audit/write-audit.ts`)
  writing to the append-only `public.audit_logs`, `handleRouteError()` + `Conflict` (`apps/web/lib/api/respond.ts`),
  the Drizzle client `db` (`@brazil-tms/db`), the UTC-`timestamptz` + manual-`updatedAt` + soft-delete
  conventions, and the 002 master-data FKs (`customers`, `locations`, `lanes`).
- **Rationale**: Constitution I (DRY/YAGNI) and the slice-003 mandate to *reuse* the audit/auth foundation.
  003 is a consumer of that foundation plus the system-of-record owner for trips.
- **Alternatives**: A 003-local auth/audit layer — rejected (duplicates the single source of truth, violates
  Constitution IV and FR-018).

## R1 — Where the status state-machine is enforced (and where the table lives)

- **Decision**: The **single transition table** is a plain data structure in
  `packages/shared/src/domain/trip-status.ts` (`TRANSITIONS`, `canTransition(from, to)`). Enforcement is in
  the **service layer** (`apps/web/lib/trips/trip-transitions.ts`) which all later slices' route handlers
  call. Postgres holds a `trip_status` `pgEnum` (membership only) — **no DB trigger** encodes legality.
- **Rationale**: The BFF/service layer is already the authz + business-rule layer (Constitution IV, RLS
  deferred). One TypeScript table is trivially unit-testable, is imported by slices 004–009 unchanged (FR-023),
  and keeps logic out of opaque SQL triggers (Constitution I & III: explicit transitions). Defining the table
  once in `shared` mirrors how 001's permission catalog lives in `shared`.
- **Alternatives**: Postgres trigger/`CASE` enforcing transitions — rejected (opaque, hard to test, only
  needed if Postgres were exposed directly, which it is not). A DB lookup table of transitions — rejected
  (join per check; over-engineering vs a static table; ≥3 rule).

## R2 — Status representation: one `pgEnum` of all 18 statuses

- **Decision**: `trip_status` `pgEnum` with exactly the spec's 18 values: `received`, `validation_error`,
  `validated`, `assigned`, `confirmed`, `at_origin`, `loading`, `loaded`, `in_transit`, `at_destination`,
  `unloading`, `unloaded`, `completed`, `billing_pending`, `billing_ready`, `billed`, `cancelled`, `disputed`.
  `trips.current_status` is `trip_status NOT NULL DEFAULT 'received'`.
- **Rationale**: Type-safe at query time (Drizzle), explicit and enumerated (Constitution III), matches 002's
  `pgEnum` convention (`resource_status`, `vehicle_type`). Adding a status later is a one-line
  `ALTER TYPE ... ADD VALUE` migration — acceptable friction for the integrity guarantee.
- **Alternatives**: `text` + CHECK — rejected (loses enum type safety; Constitution III prefers enumerations).
  Lookup table — rejected (join overhead, YAGNI).

## R3 — Billing status is a derived projection, not a stored field (Clarification Q2)

- **Decision**: There is **no** `billing_status` column. `billingStatus(currentStatus)` is a pure function in
  `packages/shared/src/domain/trip-status.ts` returning the billing-phase value when
  `current_status ∈ {billing_pending, billing_ready, billed, disputed}`, else `null`. The trip DTO surfaces it
  as a computed field (mirroring 002's derived `documentExpiryState`).
- **Rationale**: The clarified spec says the billing-phase states are the **tail of the single machine**, and
  any `billing status` is a projection (SC-005, FR-013). A stored second column could drift from
  `current_status` (e.g., `Completed` but `billing_ready`) — impossible by construction with a projection.
  No second state machine (Constitution I/III).
- **Alternatives**: Postgres generated column — rejected (Drizzle doesn't expose generated columns cleanly;
  a TS function is simpler and is computed in the same `toDto` layer as other derived fields). A stored,
  independently-mutated `billing_status` — rejected (the exact divergence Q2 ruled out).

## R4 — Planned vs. executed: immutable snapshot + live plan columns + events (TRIP-006)

- **Decision**: Three layers on/around `trips`:
  1. `original_plan jsonb NOT NULL` — an **immutable** snapshot of the imported plan, written once at create,
     never updated. Directly satisfies SC-002 ("original imported plan remains exactly retrievable").
  2. Live `planned_*` columns (pickup/delivery window start/end, `planned_vehicle_type`,
     volume/weight/pallets, route notes, `planned_service_requirements jsonb`) — the **current accepted plan**,
     updatable **only** via an audited customer-update (R5).
  3. **Executed** values are **not** columns — they are `trip_events` (R6). "Actual origin arrival" = a
     `trip_event`, never an overwrite of a planned column.
- **Rationale**: TRIP-006 / FR-002–FR-004 require an immutable original, a mutable-with-audit current plan,
  and executed-separate. The `jsonb` snapshot makes the original retrievable without walking the audit chain;
  explicit `planned_*` columns stay queryable for later filtering.
- **Alternatives**: Audit-log-only original (derive by replay) — rejected (every read needs a subquery;
  fragile). Single `jsonb` for the whole live plan — rejected (loses per-field queryability/indexing); the
  open-ended bit (`service_requirements`) is `jsonb`, the rest are columns.

## R5 — Plan updates: audited, original preserved, post-`Confirmed` review gate

- **Decision**: `updateTripPlan(tripId, changes, actor)` updates the live `planned_*` columns inside one
  transaction and writes a `trip.plan_update` audit row with per-field `previousValue`/`newValue`.
  `original_plan` is never touched. If `current_status` is past `Confirmed`, the update requires the caller to
  pass an explicit authorized-review flag (permission-gated) or it is refused (FR-005).
- **Rationale**: §19.1 + FR-004/FR-005. The original is preserved two ways (immutable snapshot + first
  audit's `previousValue`); changes are fully audited (TRIP-007).
- **Alternatives**: Free post-`Confirmed` edits — rejected (FR-005). Immutable everything (no plan updates) —
  rejected (customers re-plan; §19.1 requires accepting updates with audit).

## R6 — Trip Event table shape + atomic status transition (FR-006, FR-007, FR-015)

- **Decision**: `trip_events` columns: `id`, `trip_id` (FK), `event_type` (`trip_event_type` enum),
  `status_before`/`status_after` (`trip_status`, nullable — set for `status_change`), `event_timestamp`
  (`timestamptz`, the actual time, nullable), `source` (`trip_event_source` enum), `actor_user_id` (FK
  `users`, nullable for system/import), `location_id` (FK `locations`, nullable), `notes` (text, nullable),
  `exception_id uuid` (nullable, **no FK yet** — exceptions are owned by 007), `created_at`. A status
  transition is **one transaction**: `UPDATE trips SET current_status` + `INSERT trip_events(status_change,…)`
  + `writeAudit('trip.status_change')`. `trip_events` is hardened append-only via a manual `REVOKE UPDATE,
  DELETE` in the migration (mirroring `audit_logs`).
- **Rationale**: FR-006/FR-007 (actual timestamps as events) and FR-015 (every transition audited). One
  transaction guarantees "never unlogged" (SC-003) and protects against partial writes. `event_type` is a
  `pgEnum` (`status_change`, `origin_arrived`, `loaded`, `departed`, `destination_arrived`, `unloaded`,
  `completed`) — explicit/enumerated (Constitution III); 007 extends it (e.g., exception events) via migration.
- **Alternatives**: Async event/audit via the worker — rejected (a queue failure would drop an audit row,
  violating SC-003; STACK keeps atomic mutations synchronous). Trigger-generated events — rejected (opaque,
  Constitution I). FK on `exception_id` now — rejected (exceptions table doesn't exist until 007; keep the
  column nullable+un-constrained as a forward hook).

## R7 — Concurrency: status-guarded conditional update → 409

- **Decision**: Transitions apply with `UPDATE trips SET current_status = :to, updated_at = now() WHERE id =
  :id AND current_status = :expectedFrom`. **0 rows updated ⇒ `Conflict` (409)** — the trip already moved
  under the caller. Plan/cancel mutations use an `updated_at` guard analogously where a from-status check
  doesn't apply.
- **Rationale**: Optimistic, lock-free, and naturally tied to state-machine semantics (you transition *from*
  the status you believe you're in). Simpler than a version column (YAGNI) and than `SELECT … FOR UPDATE`
  (no deadlocks). Postgres `READ COMMITTED` + the conditional `WHERE` prevents two stale writers both winning
  (SC-001 edge case "Concurrent transitions").
- **Alternatives**: Pessimistic `SELECT FOR UPDATE` — rejected (contention is low for an ops tool; lock/
  deadlock cost). Dedicated `version int` column — rejected (the from-status check already provides the guard).

## R8 — Cancellation: fixed responsible-party enum + config-driven reason/billing-impact (FR-019–FR-022)

- **Decision**: `cancelTrip` requires all five inputs (Zod, `packages/shared/src/schemas/trip.ts`):
  `reason_code` (text, validated against config), `cancelled_by` (actor), `cancellation_timestamp`
  (defaults to `now()`), `responsible_party` (**fixed `pgEnum`** `cancellation_responsible_party` =
  `customer_caused | brazil_transports_caused | carrier_caused | unknown` — verbatim §19.5), and
  `billing_impact` (text, validated against config). Reason codes and billing-impact values live in **one**
  table `cancellation_options(kind, code, label_pt, active, sort_order, …)` with `kind ∈ {reason,
  billing_impact}`. If the active set for a required `kind` is **empty/unconfigured**, the cancellation fails
  with a clear `409 CANCELLATION_NOT_CONFIGURED` (FR-021 "missing configuration → fail"). On success: one
  transaction → `current_status = cancelled`, store `cancellation_reason_code` + `responsible_party` +
  `billing_impact` + `cancellation_timestamp` on the trip, write `trip.cancel` audit + a `status_change`
  event.
- **Rationale**: §19.5 enumerates responsible-party (fixed → enum) but leaves reason codes/billing-impact open
  and business-blocked (Constitution V config-over-code; spec Blocked items). One table with a `kind`
  discriminator avoids two near-identical tables (Constitution I) while staying genuinely data-driven and
  runtime-seedable, which is what "missing configuration → fail" needs.
- **Alternatives**: `pgEnum` for reason/billing-impact — rejected (values are unknown/business-blocked and
  must change without a type migration). Two separate config tables — rejected (duplication below the ≥3
  threshold). Hardcoded value constants — rejected (Constitution V; can't satisfy runtime "missing config →
  fail" cleanly). Seeded with documented defaults: billing-impact may be seeded with the §19.5 examples
  (`no_charge`, `cancellation_fee`, `manual_review`) **labeled as scaffolding**; reason codes seeded **empty**
  so production cancellation fails until business supplies them (tests/e2e seed their own).

## R9 — Audit expansion: reuse `audit_logs`; critical-field set as a labeled default constant

- **Decision**: Reuse the existing append-only `public.audit_logs` and `writeAudit(tx, …)`. Extend
  `AuditAction` with `trip.create`, `trip.plan_update`, `trip.status_change`, `trip.cancel`. The
  **critical-field default set** is a labeled constant `TRIP_CRITICAL_FIELDS` in
  `packages/shared/src/domain/trip-status.ts` (planned pickup/delivery windows, planned vehicle type,
  current status, billing-status projection, cancellation reason, assignment references) — **not** a DB config
  table.
- **Rationale**: DRY — one audit table, no second history table (≥3 not met; FR-018). The critical-field set
  is a **system-wide policy**, not per-customer variation, so a labeled code constant (Constitution II
  documented-default) is appropriate and simpler than a config table; it mirrors how 002 treated
  documented-default value sets. Immutability is already DB-enforced on `audit_logs` (`REVOKE UPDATE, DELETE`);
  the same `REVOKE` is added for `trip_events` (FR-017).
- **Alternatives**: `trip_critical_fields` DB config table — rejected for MVP (speculative; the set is a
  global policy, not customer variation; YAGNI). A separate `trip_audit_log` table — rejected (violates DRY/FR-018).

## R10 — Worker: not needed this slice

- **Decision**: All 003 operations (create, transition, plan-update, cancel) are **synchronous** single-
  transaction service calls. The pg-boss/graphile worker is **not** used.
- **Rationale**: STACK reserves the worker for long-running async work (import parsing, SLA recompute,
  exports) owned by later slices. Transitions must be immediately visible and are a single DB write
  (Constitution I — no speculative async).
- **Alternatives**: Enqueue every transition — rejected (adds latency + a failure mode for no benefit).

## R11 — Minimal internal/admin visibility: read-only inspector only

- **Decision**: This slice's only BFF surface is **read-only**: `GET /api/trips` (list) and `GET
  /api/trips/:id` (detail = trip + derived `billingStatus` + recent `trip_events` + recent `audit_logs` for
  the trip), both behind `requireAuth` + `requirePermission('manage_trips')`. The mutating domain operations
  are exposed as **service functions** (reused by slices 004–009) and verified by Vitest integration tests,
  not by operational endpoints (those belong to 004 import / 005 control tower / 006 dispatch / 007 execution).
- **Rationale**: YAGNI + slice ownership. The spec asks for "minimal internal/admin visibility needed to
  verify the model," not an operational UI. Building mutation endpoints here would pre-empt later slices'
  ownership.
- **Alternatives**: Full CRUD/transition endpoints + UI — rejected (out of scope; slices 004–007). Tests only,
  no endpoints — rejected (a read-only inspector aids ops/debugging and gives Playwright an auth surface to assert).

## R12 — What is explicitly NOT built (scope guard, Constitution II)

- **Decision**: Not in this slice: import engine/UI (004); control tower / trip list / detail UI / dashboard
  (005); dispatch assignment + conflict warnings + the assignment table/FK (006); interactive execution
  timeline, exception entity/lifecycle, SLA-status **computation** + alerts (007); documents, completion
  validation, billing-readiness **enforcement** (gating predicates), rates, billing export (008); reporting +
  audit-history **views** (009). A `sla_status` placeholder may exist but is **not computed** here. The
  `exception_id` column on `trip_events` is a forward hook with no FK until 007.
- **Rationale**: Constitution II (scope) + `docs/SPEC-SLICING.md`. These features add their own
  columns/tables/endpoints anchored on the trip row this slice defines.
- **Alternatives**: Pulling any of the above forward — rejected (scope creep the team cannot absorb).
