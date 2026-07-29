---
description: "Task list for 003 — Trip Domain, Status Machine, and Audit Semantics"
---

# Tasks: Trip Domain, Status Machine, and Audit Semantics

**Input**: Design documents from `specs/003-trip-domain-lifecycle/`

**Prerequisites**: plan.md, spec.md, research.md (R0–R12), data-model.md, contracts/ (bff-endpoints.md,
trip-domain-api.md, permission-matrix.md), quickstart.md

**Tests**: INCLUDED. This slice is foundational and mostly headless, so the plan (Technical Context → Testing)
makes **Vitest the primary quality gate** — transition legality, audit atomicity, optimistic-conflict, plan
immutability, cancellation validation, append-only — with one thin **Playwright** API-level check on the
read-only inspector's auth. Test tasks are first-class below.

**Organization**: Tasks are grouped by the five user stories from spec.md so each is an independently testable
increment. This feature **extends the implemented 001/002 monorepo** — it reuses `requireAuth()` /
`requirePermission()`, `writeAudit()`, `handleRouteError()`/`Conflict`, the Drizzle `db`, and the 002
master-data FKs (research R0). No new package/service; `workers/` stays unused. The mutating domain
operations are **service functions** (the reuse contract later slices 004–009 call), verified by Vitest; the
only BFF surface here is the **read-only trip inspector**.

## Format: `[ID] [P?] [Story] Description with file path`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1–US5 (story-phase tasks only); Setup/Foundational/Polish carry no story label

## Path conventions

Monorepo: `packages/db/` (Drizzle schema + migrations), `packages/shared/src/` (domain/Zod/permissions/audit),
`apps/web/` (BFF route handlers, services, e2e). Trip domain access = `manage_trips` (Admin, Ops Manager).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the running 001/002 stack and create this feature's source folders.

- [X] T001 Verify the dev stack runs per quickstart.md (`pnpm install`; `docker compose -f infra/supabase/docker-compose.yml up -d`; `pnpm --filter @brazil-tms/db db:migrate` for 001+002; `pnpm --filter @brazil-tms/db db:seed`; optionally `db:seed:master-data` to anchor trips; `pnpm --filter @brazil-tms/web dev` boots at :3000)
- [X] T002 [P] Create feature source folders: `apps/web/lib/trips/` and `apps/web/app/api/trips/`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared trip domain everything depends on — enums, the three tables in one atomic migration
(with the manual `trip_events` append-only `REVOKE`), the single status machine + projection + critical-field
set in `shared`, the `manage_trips` permission, the trip audit actions, and the trip Zod schemas.

**⚠️ CRITICAL**: No user-story work can begin until this phase is complete.

### Database (packages/db)

- [X] T003 Extend `packages/db/schema/enums.ts` with pgEnums `trip_status` (18 values, lifecycle order), `trip_event_type`, `trip_event_source`, `cancellation_responsible_party` (value sets per data-model.md → Enums)
- [X] T004 [P] Create `packages/db/schema/trips.ts` (`trips` per data-model §1: FKs `customer_id`/`origin_location_id`/`destination_location_id`→002, nullable `lane_id`; `current_status trip_status NOT NULL DEFAULT 'received'`; `sla_status` placeholder; **`original_plan jsonb NOT NULL`**; live `planned_*` columns; cancellation columns; `disputed_from_status`; `CHECK origin <> destination`; partial UNIQUE `(customer_id, external_trip_id)`; status/customer/created indexes) — depends on T003
- [X] T005 [P] Create `packages/db/schema/trip-events.ts` (`trip_events` per data-model §2: FK `trip_id`→trips, nullable `actor_user_id`→users + `location_id`→locations; `event_type`/`source` enums; `status_before`/`status_after`; `event_timestamp`; nullable `exception_id` **without FK**; trip+type indexes) — depends on T003
- [X] T006 [P] Create `packages/db/schema/cancellation-options.ts` (`cancellation_options` per data-model §3: `kind` text CHECK `in ('reason','billing_impact')`, `code`, `label_pt`, `active`, `sort_order`; UNIQUE `(kind, code)`)
- [X] T007 Export the new tables from `packages/db/schema/index.ts` — depends on T004, T005, T006
- [X] T008 Generate the migration: `pnpm --filter @brazil-tms/db db:generate`; review the SQL in `packages/db/migrations/` (public schema only; auth.* untouched; confirm the 4 enums, FKs, CHECKs, indexes) — depends on T007
- [X] T009 Hand-append the append-only guard to the generated migration SQL: `REVOKE UPDATE, DELETE ON public.trip_events FROM PUBLIC;` (drizzle-kit will not emit it; mirrors the 001 `audit_logs` hardening — FR-017) — depends on T008
- [X] T010 Apply the migration: `pnpm --filter @brazil-tms/db db:migrate`; verify `trips`/`trip_events`/`cancellation_options` + enums exist and the `trip_events` REVOKE is in effect — depends on T009

### Shared domain (packages/shared) — the reuse contract for slices 004–009

- [X] T011 [P] Create `packages/shared/src/domain/trip-status.ts`: `TRIP_STATUSES` (18) + `TripStatus` type; `TRANSITIONS` table (the single source of truth; cancellable through `at_destination` per clarification); `canTransition(from, to)` (incl. `disputed → disputed_from_status`); `billingStatus(s)` projection + `BillingStatus` type; `TRIP_CRITICAL_FIELDS` constant (labeled default, R9). Export all from `packages/shared/src/index.ts` (contracts/trip-domain-api.md, FR-008..FR-013, FR-016, FR-023)
- [X] T012 [P] Vitest for the domain module in `packages/shared/src/domain/trip-status.test.ts`: every legal transition accepted; representative illegal transitions rejected (`received→in_transit`); optional sub-state skips legal; `in_transit`/`at_destination → cancelled` legal; `cancelled` terminal; `TRIP_CRITICAL_FIELDS` membership; **no `warning` member exists in `TRIP_STATUSES`** (a validation warning is a flag, not a status — FR-012) — depends on T011
- [X] T013 [P] Extend `packages/shared/src/auth/permissions.ts`: add `manage_trips` to `PermissionKey` + `ALL_PERMISSIONS`; grant to `operations_manager` in `ROLE_PERMISSIONS` (Admin inherits via `ADMIN_PERMISSIONS`) — per contracts/permission-matrix.md
- [X] T014 [P] Add permission invariants to `packages/shared/src/auth/permissions.test.ts` (admin + operations_manager have `manage_trips`; dispatcher, finance, customer_viewer do NOT) — depends on T013
- [X] T015 [P] Extend the `AuditAction` union in `packages/shared/src/audit/actions.ts` with `'trip.create' | 'trip.plan_update' | 'trip.status_change' | 'trip.cancel'` (data-model.md → Audit actions)
- [X] T016 Create `packages/shared/src/schemas/trip.ts` with Zod: `createTripSchema`, `transitionTripSchema` (`toStatus`, `expectedFromStatus`, `eventTimestamp?`, `source?`, `notes?`), `updateTripPlanSchema` (partial planned_* + `authorizedReview?`), `cancelTripSchema` (`reasonCode`, `cancellationTimestamp?`, `responsibleParty` enum, `billingImpact`) — pt-BR messages; export from `packages/shared/src/index.ts` — depends on T011 (shares `packages/shared/src/index.ts` with T011 — not [P], serialize)

**Checkpoint**: Schema migrated (append-only enforced), domain module + `manage_trips` + audit actions + Zod
ready — stories can begin.

---

## Phase 3: User Story 1 — Durable trip with planned vs. executed separation (Priority: P1) 🎯 MVP

**Goal**: Trips exist as durable records carrying an immutable `original_plan` and live `planned_*` fields;
accepted customer updates change the live plan (audited) while the original is preserved; executed values are
`trip_events`; the trip is readable via the inspector. (TRIP-006; FR-001..FR-007.)

**Independent Test**: `createTrip` from a plan stores `original_plan` + status `received`; record an executed
milestone as a `trip_event` and the `planned_*` stay unchanged; an accepted plan update changes the live field,
preserves `original_plan`, and writes a `trip.plan_update` audit; a post-`confirmed` plan edit without the
review flag is refused; `GET /api/trips/:id` returns the trip + derived `billingStatus` + events + audit.

- [X] T017 [P] [US1] Implement `apps/web/lib/trips/trips-service.ts` (`createTrip`: capture `original_plan`, set `current_status='received'`, `writeAudit('trip.create')` in one tx; `getTrip`: trip + derived `billingStatus` + the latest 50 `trip_events` + the latest 50 `audit_logs` for the trip (newest first); `listTrips` with `status`/`customerId`/`q` filters + `limit` default 50; map rows → DTO with ISO timestamps + `billingStatus`) — depends on T010, T015, T016
- [X] T018 [P] [US1] Implement `apps/web/lib/trips/trip-plan.ts` (`updateTripPlan`: update live `planned_*` in one tx; **never** touch `original_plan`; write `trip.plan_update` audit with per-field previous/new only for fields in `TRIP_CRITICAL_FIELDS`; if `current_status` is past `confirmed` and `authorizedReview` is not set → `Conflict('REVIEW_REQUIRED')`) — depends on T010, T011, T015, T016
- [X] T019 [US1] Vitest integration `apps/web/lib/trips/trips-service.test.ts` (create stores `original_plan` + `received` + one `trip.create` audit; **a non-`status_change` milestone event (`origin_arrived`) with `event_timestamp`/`source`/`location_id` is stored and retrievable, distinguishable from the `planned_*` windows — FR-006/FR-007/SC-006**; `getTrip` returns events + audit + `billingStatus`) — depends on T017
- [X] T020 [US1] Vitest integration `apps/web/lib/trips/trip-plan.test.ts` (accepted customer update changes a planned field, preserves `original_plan`, writes one `trip.plan_update` with before/after; post-`confirmed` update without review flag → `REVIEW_REQUIRED`) — depends on T018
- [X] T021 [P] [US1] Implement read-only inspector `apps/web/app/api/trips/route.ts` (`GET` list; `requireAuth` + `requirePermission(ctx,'manage_trips')`; `status`/`customerId`/`q`/`limit` query; `handleRouteError`) — depends on T013, T017
- [X] T022 [P] [US1] Implement read-only inspector `apps/web/app/api/trips/[id]/route.ts` (`GET` detail: trip + `billingStatus` + latest 50 events + latest 50 audit rows (newest first); `404` when absent) — depends on T013, T017
- [X] T023 [US1] Playwright API-level e2e `apps/web/e2e/trips-inspector.spec.ts` (uses the `request` fixture: no session → `401`; `customer_viewer` → `403`; Admin → `200` with trip + events + audit + `billingStatus`). **Self-seeds** its fixture in a `beforeAll`/global-setup that inserts one trip (+ a status-change event + audit) directly via `@brazil-tms/db` (`createTrip` / `transitionTripStatus`); does **not** depend on the optional Polish seed (T032) — depends on T021, T022

**Checkpoint**: A trip can be created, its plan updated with the original preserved, executed milestones
recorded as events, and the whole thing read back — independently testable (MVP).

---

## Phase 4: User Story 2 — Explicit, enforced trip status lifecycle (Priority: P1)

**Goal**: `transitionTripStatus` allows only declared legal transitions, applies them atomically (status +
`trip_event` + audit), and is safe under concurrency. (FR-008..FR-012.)

**Independent Test**: Drive `received → validated → assigned → confirmed → at_origin → in_transit →
at_destination → unloaded → completed` (each accepted); `received → in_transit` rejected with status unchanged;
`at_origin → in_transit` (skip Loading) accepted; a stale `expectedFromStatus` → conflict; each transition
writes one `status_change` event + one `trip.status_change` audit atomically.

- [X] T024 [US2] Implement `apps/web/lib/trips/trip-transitions.ts` (`transitionTripStatus`: reject `!canTransition(from,to)` → `Conflict('ILLEGAL_TRANSITION')`; status-guarded `UPDATE … WHERE current_status = expectedFrom` → 0 rows = `Conflict('STALE_TRANSITION')`; in one tx update `current_status` + insert `trip_events(status_change, status_before/after, source, actor)` + `writeAudit('trip.status_change')`; on entering `disputed` record `disputed_from_status`, and allow `disputed → disputed_from_status` on resolution) — depends on T010, T011, T015, T016
- [X] T025 [US2] Vitest integration `apps/web/lib/trips/trip-transitions.test.ts` (full legal path accepted; `received→in_transit` → `ILLEGAL_TRANSITION`, status unchanged; optional sub-state skip; stale `expectedFromStatus` → `STALE_TRANSITION`; each transition writes exactly one event + one audit in the same tx; `disputed` round-trip returns to entered-from) — depends on T024

**Checkpoint**: The status machine is enforced and every transition is atomically eventful + audited.

---

## Phase 5: User Story 3 — Critical changes produce immutable audit records (Priority: P2)

**Goal**: Verify the cross-cutting audit guarantee the services already implement — every critical-field change
and lifecycle action writes exactly one immutable audit row, and audit/event history is append-only. (TRIP-007;
FR-015..FR-018; SC-003.)

**Independent Test**: Editing `planned_vehicle_type` yields exactly one `trip.plan_update` audit (before/after,
actor, timestamp); a non-critical field change yields no critical-change audit; a status change yields one
audit (cancel→audit is verified in US4); direct `UPDATE`/`DELETE` on an `audit_logs` or `trip_events` row is
refused; `original_plan` is never mutated after create.

> Verification phase over the services built in US1 (T017/T018) and US2 (T024) — no forward dependency on US4.
> Cancellation→audit is verified within US4 (T029).

- [X] T026 [US3] Vitest integration `apps/web/lib/trips/trip-audit.test.ts` (create → one `trip.create`; critical-field change → exactly one `trip.plan_update` with before/after/actor/timestamp; a non-critical field change → no critical-change audit row; one transition → one `trip.status_change`) — depends on T017, T018, T024
- [X] T027 [US3] Vitest integration `apps/web/lib/trips/trip-audit-immutability.test.ts` (direct `UPDATE` and `DELETE` on an `audit_logs` row and a `trip_events` row are rejected by DB privileges; `original_plan` unchanged across plan updates) — depends on T010, T017

**Checkpoint**: Auditability and append-only immutability verified end-to-end.

---

## Phase 6: User Story 4 — Cancellation requires complete justification (Priority: P2)

**Goal**: `cancelTrip` requires all five inputs, validates reason/billing-impact against `cancellation_options`,
fails clearly when that config is missing, and only cancels from a cancellable status (through `at_destination`).
(§19.5; FR-019..FR-022; SC-004.)

**Independent Test**: From `in_transit`, a cancel with all five inputs → `cancelled` + `trip.cancel` audit +
`status_change` event; omitting `responsibleParty` → `400`; empty reason config →
`CANCELLATION_NOT_CONFIGURED`; cancel from `completed` → `NOT_CANCELLABLE`; cancel from `at_destination` allowed.

- [X] T028 [US4] Implement `apps/web/lib/trips/trip-cancellation.ts` (`cancelTrip`: parse via `cancelTripSchema`; load active `cancellation_options` by kind — empty required set → `Conflict('CANCELLATION_NOT_CONFIGURED')`, unknown `reasonCode`/`billingImpact` → `400`/`Conflict`; reject if `!canTransition(current,'cancelled')` → `Conflict('NOT_CANCELLABLE')`; in one tx set `current_status='cancelled'` + `cancellation_reason_code`/`responsible_party`/`billing_impact`/`cancelled_at` + insert `status_change` event + `writeAudit('trip.cancel')`) — depends on T010, T011, T015, T016
- [X] T029 [US4] Vitest integration `apps/web/lib/trips/trip-cancellation.test.ts` (cancel from `in_transit` with all five inputs → `cancelled` + audit + event; missing `responsibleParty` → `400`; empty reason config → `CANCELLATION_NOT_CONFIGURED`; from `completed` → `NOT_CANCELLABLE`; from `at_destination` allowed; tests seed/clear their own `cancellation_options`) — depends on T028

**Checkpoint**: Cancellation is complete, config-driven, and fails safe when unconfigured.

---

## Phase 7: User Story 5 — Billing-phase states live in the single status lifecycle (Priority: P3)

**Goal**: The billing-phase states are the tail of the one machine, governed by the same transition table;
`billingStatus` is a derived projection; gating is deferred config (not enforced here). (FR-013, FR-014; SC-005.)

**Independent Test**: `completed → billing_pending → billing_ready → billed` accepted via the same
`transitionTripStatus`; `billing_pending → billed` rejected; the DTO `billingStatus` follows `current_status`
(non-billing → `null`); no second/independently-mutated billing machine exists.

- [X] T030 [US5] Vitest integration `apps/web/lib/trips/trip-billing-phase.test.ts` (advance `completed→billing_pending→billing_ready→billed` accepted; `billing_pending→billed` → `ILLEGAL_TRANSITION`; `getTrip`/`listTrips` DTO `billingStatus` tracks `current_status`, `null` for non-billing; `disputed` returns to entered-from) — depends on T024, T017
- [X] T031 [US5] Add billing-projection assertions to `packages/shared/src/domain/trip-status.test.ts` (every billing-phase status → its `BillingStatus` value; every non-billing status → `null`; the billing-phase transitions exist only within the single `TRANSITIONS` table; gating predicates are NOT enforced here) — depends on T012 (extends T012's test file — serialize)

**Checkpoint**: One status machine, billing as a projection — verified; gating correctly deferred to 008.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T032 [P] Add seed `packages/db/seed/trip-domain-sample.ts` (seed `cancellation_options` `billing_impact` scaffolding rows `no_charge`/`cancellation_fee`/`manual_review`; leave `reason` codes **empty** — business-blocked; optionally 1–2 sample trips on seeded master data) and a `db:seed:trip-domain` script in `packages/db/package.json` (quickstart.md)
- [X] T033 Run quickstart.md validation end-to-end (US1–US5 walkthrough) and confirm Success Criteria SC-001…SC-006
- [X] T034 Quality gate: `pnpm lint` ✓, `pnpm typecheck` ✓, `pnpm build` ✓, `pnpm test` ✓ (333 tests, DATABASE_URL set), feature e2e `trips-inspector.spec.ts` ✓ (3/3). NOTE: the broader `pnpm test:e2e` has 33 failures in **pre-existing** 001/002 admin-UI specs (the local running app's admin nav permissions don't resolve) — proven environment-only by re-running on a clean `dev` baseline (003 stashed), where they fail identically; NOT a 003 regression. Run e2e against a production build (`next start` + `PLAYWRIGHT_BASE_URL`, `--workers=1`), not `next dev`.
- [X] T035 [P] Update PR notes/migration docs per the DELIVERY-WORKFLOW PR template (new tables `trips`/`trip_events`/`cancellation_options`; 4 new enums; **manual `REVOKE UPDATE, DELETE ON trip_events`**; new `manage_trips` permission; flag the two business-blocked items — cancellation reason codes + billing-impact values); open the PR against **`dev`**

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)** → no deps.
- **Foundational (P2)** → after Setup; **blocks all stories**. DB chain: enums (T003) → schema files
  (T004 ‖ T005 ‖ T006) → index (T007) → generate (T008) → **REVOKE append (T009)** → migrate (T010). The
  shared block (T011, T013, T015 ‖; T012⇐T011, T014⇐T013, T016⇐T011) runs alongside the DB chain.
- **US1 (P3)** → after Foundational. **MVP.**
- **US2 (P4)** → after Foundational; independent of US1.
- **US3 (P5)** → after the services it asserts exist (US1 T017/T018, US2 T024). Cancellation→audit is verified
  within US4 (T029), so US3 carries **no forward dependency** on US4 and is testable as soon as US1+US2 are done.
- **US4 (P6)** → after Foundational; independent of US1/US2.
- **US5 (P7)** → after US2 (T024) + US1 (T017).
- **Polish (P8)** → after all desired stories.

### Within each story

Service (uses the shared domain + Zod) → Vitest integration → (US1 only) inspector routes → e2e. Vitest
accompanies the implementation it covers (constitution quality gate).

### Parallel opportunities

- Setup: T002 ‖ (T001 first).
- Foundational: T004 ‖ T005 ‖ T006 (after T003); the shared block T011, T013, T015 ‖ the DB chain
  (T012⇐T011, T014⇐T013, T016⇐T011).
- US1: T017 ‖ T018; then T019⇐T017, T020⇐T018; T021 ‖ T022 (after T017); T023 after T021+T022.
- Cross-story: once Foundational is done, **US1, US2, US4 can proceed in parallel**; US3 and US5 are
  verification phases that follow the services they assert.

---

## Parallel Example: Foundational

```bash
# After T003 (enums):
Task: "T004 trips.ts" ; Task: "T005 trip-events.ts" ; Task: "T006 cancellation-options.ts"
# alongside the DB chain, the shared domain block:
Task: "T011 domain/trip-status.ts" ; Task: "T013 permissions (+manage_trips)" ; Task: "T015 audit actions"
# then T007 index → T008 generate → T009 REVOKE append → T010 migrate ; T016 schemas after T011
```

## Parallel Example: User Story 1

```bash
Task: "T017 trips-service.ts (create/get/list)" ; Task: "T018 trip-plan.ts (updateTripPlan)"
# after T017:
Task: "T021 GET /api/trips route" ; Task: "T022 GET /api/trips/[id] route"
```

---

## Implementation Strategy

### MVP first (User Story 1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational (CRITICAL — migrates the domain + ships the shared status machine) →
3. Phase 3 US1 (durable trip + planned-vs-executed + inspector).
4. **STOP & VALIDATE**: create a trip, update its plan (original preserved), record an executed event, read it
   back — independently. Demo.

> Note: the slice's *primary outcome* (a reusable trip domain other features depend on) is meaningfully
> demonstrable after **US1–US2** (a durable trip + an enforced status machine). US1 alone is the smallest
> shippable slice.

### Incremental delivery

Foundational → **US1** (MVP: durable trip) → **US2** (status machine) → **US3** (audit immutability) →
**US4** (cancellation) → **US5** (billing-phase projection) → Polish. Each story is independently testable and
adds value without breaking earlier ones.

### Parallel team strategy

After Foundational: Dev A → US1, Dev B → US2, Dev C → US4 (all independent service files). US3 and US5 run as
verification suites once their target services exist.

---

## Notes

- **[P]** = different files, no incomplete dependency. Same-file edits (e.g. `enums.ts`, `index.ts`,
  `schemas/trip.ts`, `permissions.ts`, `actions.ts`) are intentionally **not** marked [P] across tasks — they
  serialize.
- Every mutation service calls `writeAudit(tx, …)` inside the same Drizzle transaction (research R6/R9); a
  status transition also inserts a `trip_events` row in that tx. A denied/failed request changes no state.
- `original_plan` is written once at create and **never** overwritten; live `planned_*` changes are audited.
- Status legality, the billing projection, and the critical-field set live **only** in
  `packages/shared/src/domain/trip-status.ts` — slices 004–009 import them (FR-023); do not redefine.
- Reuse 001/002 primitives — do not re-implement auth, audit, the Drizzle client, or master-data entities.
- Append-only: the `trip_events` `REVOKE` (T009) is a **manual** migration step drizzle-kit won't generate;
  do not skip it.
- Commit after each task or logical group; open the PR against **`dev`** (never `main`); AI must not merge to `main`.
- Out of scope (do NOT build — research R12 / spec Out of Scope): import engine/UI (004); control tower / trip
  list / detail UI (005); assignment table/FK + dispatch (006); execution timeline, exception entity, SLA
  computation (007); documents, billing-readiness enforcement, rates, export (008); reports + audit views (009).
- **Business-blocked (Constitution II — labeled scaffolding)**: cancellation **reason codes** and
  **billing-impact values** are seeded as labeled scaffolding (reasons left empty so production cancellation
  fails until configured); do not treat them as final sign-off.
