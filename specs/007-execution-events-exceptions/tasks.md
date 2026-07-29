# Tasks: Execution Events, Exceptions, SLA Risk, and In-App Alerts

**Input**: Design documents from `/specs/007-execution-events-exceptions/`
**Prerequisites**: plan.md (required), spec.md (user stories US1–US5), research.md (R0–R16), data-model.md (4 tables / 3 enums / ALTERs / domain logic / services / read models / migration 0006), contracts/ (bff-endpoints.md, permission-matrix.md), quickstart.md
**Tests**: INCLUDED — explicitly required by the plan's Testing section, Constitution §3.13 (the pure SLA evaluator + exception lifecycle, status/permission checks, worker sweep), and quickstart.md.

**Organization**: Tasks are grouped by user story so each story is independently implementable and testable. Setup → Foundational (blocking) → US1 (P1) → US2 (P1) → US3 (P1) → US4 (P2) → US5 (P2) → Polish.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1..US5 for story-phase tasks (Setup / Foundational / Polish have no story label)
- Exact repo-relative file paths are in each description

## Path Conventions

Existing monorepo (per plan.md Project Structure): `packages/shared/src/`, `packages/db/{schema,src,migrations,seed}/`, `workers/`, `apps/web/`. **Four new tables** (`reason_codes`, `exceptions`, `customer_sla_rules`, `alerts`); **three new pgEnums** (`exception_status`/`exception_severity`/`exception_responsible_party`); `alert_case`/`alert_state`/`reason_codes.category`/`sla_status` are CHECK text; **one** new `trip_event_type` member (`note`); **no new permission key, package, or worker process**. SLA/alert authority is server-side (a pure evaluator the BFF + worker call); freshness is polling; UI is pt-BR; timestamps UTC.

---

## Phase 1: Setup

**Purpose**: Branch off `dev` for the slice.

- [X] T001 Create the short-lived feature branch `007-execution-events-exceptions` off `dev` (`git checkout -b 007-execution-events-exceptions dev`)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared domain logic + Zod + audit/jobs contracts, the four-table schema + migration 0006, the SLA recompute engine + alert helpers + read-model extensions, the extended read routes, i18n/nav, the worker queue wiring, and the pure unit tests that ALL user stories depend on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Shared (`@brazil-tms/shared`)

- [X] T002 [P] Create the pure SLA evaluator in `packages/shared/src/domain/sla-risk.ts`: `evaluateSlaRisk(ctx, policy): { status: SlaStatus; reasons: SlaReason[] }`, `SLA_STATUSES = ['on_track','at_risk','late','breached'] as const` (ordinal = severity), `SLA_REASONS` (the 7 triggers), the `SlaContext`/`SlaPolicy` types, and `DEFAULT_SLA_POLICY` (atRiskWarning 60 / pickupTolerance 0 / deliveryTolerance 0 / confirmationCutoff 120 / timeInStatus 120). Encode D1 (window-miss⇒Late; assignment/confirmation/loading/departure/high-sev-exception⇒At Risk; none⇒On Track; Breached never produced), D2 (worst-state-wins, all reasons retained), no-planned-window branch, time-in-status branch, and the terminal/cancelled short-circuit — per data-model §9.1 (mirror `domain/assignment-eligibility.ts`)
- [X] T003 [P] Create the pure exception-lifecycle module in `packages/shared/src/domain/exceptions.ts`: `EXCEPTION_STATUSES`, `EXCEPTION_SEVERITIES` (`low|medium|high`, `high` = SLA/alert trigger), `EXCEPTION_RESPONSIBLE_PARTIES` (the **5-value** set incl. `force_majeure`), `REASON_CODE_CATEGORIES` (the 12 EXC-004 values), the `EXCEPTION_TRANSITIONS` map, and `canTransitionException(from, to)` (Open↔Monitoring; →Resolved/Cancelled; Resolved/Cancelled terminal) — per data-model §9.2 (mirror `domain/trip-status.ts`)
- [X] T004 [P] Create the SLA job contract in `packages/shared/src/sla/jobs.ts`: `SLA_JOBS = { slaSweep: "sla.sweep" } as const`, `SlaJobName`, `SlaSweepPayload` (empty), `SlaJobPayloads` — pure, no pg-boss import (sibling of `import/jobs.ts`), per data-model §9.3
- [X] T005 [P] Extend the `AuditAction` union AND `ALL_AUDIT_ACTIONS` in `packages/shared/src/audit/actions.ts` with `exception.create` / `exception.update` / `exception.resolve` / `exception.cancel` / `trip.note` / `sla_rule.create` / `sla_rule.update` (keep both in lockstep so the `satisfies` check passes; milestones reuse the existing `trip.status_change`; SLA recompute + alerts are NOT audit actions) — per data-model §9.4 / R13
- [X] T006 [P] Create `packages/shared/src/schemas/trip-event.ts` exporting `addTripNoteSchema` (`notes` `z.string().trim().min(1).max(2000)`, optional `locationId`/`exceptionId` via `optionalUuid`, optional `eventTimestamp` `z.coerce.date().optional()`) — milestone recording reuses 003's `transitionTripSchema` from `./trip`, not redefined (data-model §10)
- [X] T007 [P] Create `packages/shared/src/schemas/exception.ts` exporting `createExceptionSchema` (`reasonCodeId` uuid, `severity` `z.enum(EXCEPTION_SEVERITIES).optional()`, `responsibleParty` `z.enum(EXCEPTION_RESPONSIBLE_PARTIES).optional()`, optional `ownerUserId` uuid, `description` ≤2000), `updateExceptionSchema` (owner/severity/responsibleParty/description all optional, ≥1 present), `transitionExceptionSchema` (`expectedFromStatus`/`toStatus` `z.enum(EXCEPTION_STATUSES)`, `closureNotes` required when `toStatus='resolved'` via `superRefine`, ≤2000), and `exceptionFilterSchema` (severity/customerId/laneId/reasonCodeId/ownerUserId/age + paging) for the Exception Management list — per data-model §10 / contracts §6
- [X] T008 [P] Create `packages/shared/src/schemas/customer-sla-rule.ts` exporting `createSlaRuleSchema` and `updateSlaRuleSchema` (`customerId` uuid; the four minute fields `z.number().int().nonnegative()`; optional `laneId` uuid / `vehicleType` via `vehicleTypeSchema`; optional `effectiveStart`/`effectiveEnd` `z.coerce.date()`; update partial incl. `active`) — per data-model §10 / contracts §8–9
- [X] T009 [P] Create `packages/shared/src/schemas/alert.ts` exporting `acknowledgeAlertSchema` (minimal/empty — id comes from the route param) — per data-model §10 / contracts §11
- [X] T010 [P] Extend `packages/shared/src/schemas/trip-board.ts`: add an `slaStatus` filter param (`oneOrMany(z.enum(SLA_STATUSES))`) and an `atRisk` shorthand (`optParam(z.enum(["true","false"]))`) for the "At risk" view, and add each key to `PARAM_KEYS` (a param missing from `PARAM_KEYS` silently never parses from the URL) — per data-model §10 / contracts §12
- [X] T011 Add `export *` lines to `packages/shared/src/index.ts` for `./domain/sla-risk`, `./domain/exceptions`, `./sla/jobs`, `./schemas/trip-event`, `./schemas/exception`, `./schemas/customer-sla-rule`, `./schemas/alert` (after the existing `assignment-eligibility` / `trip-assignment` / `trip-board` lines) (depends on T002, T003, T004, T006, T007, T008, T009)

### Database schema + migration (`@brazil-tms/db`)

- [X] T012 Extend `packages/db/schema/enums.ts`: add the three `pgEnum`s `exceptionStatus` (`open/monitoring/resolved/cancelled`), `exceptionSeverity` (`low/medium/high`), `exceptionResponsibleParty` (the 5-value set incl. `force_majeure`), and append `"note"` to the existing `tripEventType` member list (kept in lockstep with `@brazil-tms/shared` `TRIP_EVENT_TYPES`; **no** member for Loading/Unloading — D5; **no** `gps`/`driver_input` source) — per data-model §1, §7
- [X] T013 [P] Create `packages/db/schema/reason-codes.ts`: the `reason_codes` pgTable (`code` unique, `category` text + `reason_codes_category_ck` CHECK over the 12 EXC-004 values, `label_pt`, `default_severity`/`default_responsible_party` enum cols, `active`, `sort_order`, timestamps) — mirror `cancellation-options.ts`, per data-model §2
- [X] T014 Create `packages/db/schema/exceptions.ts`: the `exceptions` pgTable (inline FKs to trips/reason_codes/users×2; `severity`/`status`(default `open`)/`responsible_party` enum cols; `owner_user_id` NOT NULL; `description`; `opened_at`/`resolved_at`/`closure_notes`; `created_by_user_id`; timestamps) with the six indexes (`trip`/`status`/`severity`/`owner`/`reason`/`opened_at desc`) — **no** stored `category` (derived), **no** attachments column (008) — per data-model §3 (depends on T012, T013)
- [X] T015 [P] Create `packages/db/schema/customer-sla-rules.ts`: the `customer_sla_rules` pgTable (FK `customer_id`; nullable `lane_id` FK + `vehicle_type` reusing the existing `vehicleType` enum; the four `*_minutes` integer cols; `effective_start`/`effective_end`; `active`; timestamps) with `customer_sla_rules_customer_idx` and the composite `customer_sla_rules_scope_idx (customer_id, lane_id, vehicle_type)` — per data-model §4 (depends on T012)
- [X] T016 Create `packages/db/schema/alerts.ts`: the `alerts` pgTable (FK `trip_id`; `alert_case` text + `alerts_case_ck` CHECK over all 8 §17 cases incl. the 2 deferred; `severity` reusing `exceptionSeverity`; `state` text default `active` + `alerts_state_ck` CHECK; `acknowledged_by_user_id`/`acknowledged_at`/`auto_resolved_at`; timestamps) with the **partial-unique** `alerts_trip_case_open_uq ON (trip_id, alert_case) WHERE state IN ('active','acknowledged')` (mirror 006's `is_current` partial-unique) plus `alerts_trip_idx`/`alerts_state_idx` — per data-model §5 (depends on T012)
- [X] T017 Extend `packages/db/schema/trips.ts`: add `slaReasons: text("sla_reasons").array()` (the schema's **first** `.array()` column — `sla_status` type stays `text`, D4) and the `trips_sla_status_ck` CHECK (`sla_status IS NULL OR sla_status IN ('on_track','at_risk','late','breached')`) to the `(table) => [...]` array — per data-model §6
- [X] T018 Extend `packages/db/schema/trip-events.ts`: add `.references(() => exceptions.id)` to the existing `exceptionId` column (the 003 forward-hook FK 007 wires; keeps the table's append-only REVOKE) — per data-model §7 (depends on T014)
- [X] T019 Add `export * from "./reason-codes"` / `"./exceptions"` / `"./customer-sla-rules"` / `"./alerts"` to `packages/db/schema/index.ts` (after the 006 `trip-assignments` line) (depends on T013, T014, T015, T016)
- [X] T020 Generate + apply Drizzle migration `packages/db/migrations/0006_*.sql` via `pnpm --filter "@brazil-tms/db" db:generate` then `db:migrate` (next sequential after `0005_conscious_kat_farrell.sql`): `CREATE TYPE`×3 + `ALTER TYPE trip_event_type ADD VALUE 'note'` (its own statement) + `CREATE TABLE`×4 (with FKs, the 3 CHECKs, all indexes incl. the partial-unique) + `ALTER trips ADD COLUMN sla_reasons text[]` + `trips_sla_status_ck` + `ALTER trip_events ADD CONSTRAINT … FK(exception_id)→exceptions(id)`. **NO REVOKE** for the four mutable tables; `trip_events` keeps its REVOKE. **Hand-verify** before applying: (a) the cross-feature `trip_events.exception_id` FK on the pre-existing column; (b) `trips_sla_status_ck` on the pre-existing column; (c) `sla_reasons` emits as `text[]`; (d) the `alerts_trip_case_open_uq WHERE state IN (...)` predicate; (e) `ADD VALUE 'note'` ordered before first use. Verify `meta/_journal.json` updated (depends on T012, T017, T018, T019)
- [X] T021 [P] Create `packages/db/seed/reason-codes.ts` + a `db:seed:reason-codes` package script: one **labeled-scaffolding** row per EXC-004 category (12) with a sensible `default_severity`/`default_responsible_party` — explicitly NOT final business sign-off (mirrors 003's `cancellation_options` gap; unlike it, 007 seeds rows so the exception flow is demonstrable) — per data-model §2 / quickstart (depends on T020)
- [X] T022 [P] Create `packages/db/seed/sla-rules.ts` + a `db:seed:sla-rules` package script: one example `customer_sla_rules` row (so the evaluator uses it for that customer; others fall back to `DEFAULT_SLA_POLICY` → SLA sign-off blocked) — per data-model §4 / quickstart (depends on T020)

### SLA engine, alert helpers, services scaffold + read models (`@brazil-tms/db`)

- [X] T023 Create `packages/db/src/trips/sla.ts`: `recomputeTripSla(tx, tripId, actorUserId?)` (full) — gather planned windows + `current_status` + `currentStatusEnteredAt` (latest `status_change` event ts for the current status) + 006 `assignmentPresent`/`confirmedAt` + `openHighSeverityExceptionCount`; resolve the applicable `customer_sla_rules` row (`ORDER BY (lane_id IS NOT NULL) DESC, (vehicle_type IS NOT NULL) DESC, effective_start DESC NULLS LAST LIMIT 1`) or `DEFAULT_SLA_POLICY`; call `evaluateSlaRisk`; atomic `tx.update(trips).set({ slaStatus, slaReasons, updatedAt })`; terminal/cancelled short-circuit (no write); NOT separately audited — per data-model §11.2 / R11 (mind the `drizzle_sql_array_expansion` gotcha when reading `sla_reasons`) (depends on T011, T020)
- [X] T024 [P] Create `packages/db/src/trips/alerts.ts`: `generateAlert(tx, tripId, alertCase, severity)` (`INSERT … ON CONFLICT (alerts_trip_case_open_uq) DO NOTHING`), `autoResolveAlert(tx, tripId, alertCase)` (`UPDATE … SET state='resolved', auto_resolved_at=now() WHERE state IN ('active','acknowledged')`), and the `listAlerts(filters)` read + per-case/severity counts (state IN active/acknowledged, newest-first) — per data-model §5 / contracts §10–11 (acknowledge write lands in US4) (depends on T020)
- [X] T025 Extend `packages/db/src/trips/trip-dto.ts` / `loadTripDetail`: add `slaReasons: string[] | null` to `TripSummary`; add `exceptionId: string | null` to `TripEventDto` (surface the 003 column); define `ExceptionDto` (joins `reason_codes` for `category`/`labelPt`) + `AlertDto`; add `exceptions: ExceptionDto[]` and `alerts: AlertDto[]` to `TripDetail`, loaded in the **same** `loadTripDetail` executor (single source). Timeline stays `desc(createdAt) limit 50` — per data-model §12 / R14 (depends on T020)
- [X] T026 Extend `packages/db/src/trips/trips-read.ts`: add `slaReasons` to `TripBoardRow` and ensure `slaStatus` is now populated; add the `slaStatus`/`atRisk` board filter to `buildWhere` (`trips.slaStatus IN (...)` / `IN ('at_risk','late','breached')`); fill the four dashboard nulls in `queryDashboardMetrics` (`tripsAtRisk`, `activeExceptions`, `onTimePickupPct`, `onTimeArrivalPct`); extend `getTripFilterOptions`/`TripFilterOptions` with reason-code + owner option sources; add the reads `queryExceptions(filters)` (severity/customer/lane/reason/owner/age, category via `reason_code_id` join), `queryReasonCodes()` (active, ordered by `sort_order`), and `queryCustomerSlaRules()` — per data-model §12 / R14 (depends on T020)
- [X] T027 Extend `packages/db/src/index.ts`: export `recomputeTripSla` (`./trips/sla`); `generateAlert`/`autoResolveAlert`/`listAlerts` (`./trips/alerts`); `queryExceptions`/`queryReasonCodes`/`queryCustomerSlaRules` + the new read-model types (`ExceptionDto`/`AlertDto`/extended `TripFilterOptions`) (`./trips/trips-read`) (depends on T023, T024, T025, T026)

### Web foundation — extended read routes, nav, i18n (`apps/web`)

- [X] T028 [P] Update `apps/web/lib/trips/trips-read.ts` and `apps/web/lib/trips/trip-dto.ts` (server-only) to re-export the extended read models + new types (`slaReasons`, `exceptionId`, `ExceptionDto`/`AlertDto`, extended `getTripFilterOptions`, `queryExceptions`/`queryReasonCodes`/`queryCustomerSlaRules`, `listAlerts`) from `@brazil-tms/db` (depends on T027)
- [X] T029 [P] Append the `"at_risk"` preset to `DEFAULT_TRIP_VIEWS` in `apps/web/lib/trips/views.ts` (`params` → `atRisk:"true", scope:"active"`; `labelKey:"viewAtRisk"`) — the slot 005 reserved (depends on T010)
- [X] T030 [P] Extend `apps/web/app/api/trips/route.ts` (GET board, stays `view_all_trips`): parse + forward the new `slaStatus`/`atRisk` filter params and return `slaStatus` (now populated) + `slaReasons` in the `TripBoardRow` (depends on T028)
- [X] T031 [P] Extend `apps/web/app/api/trips/[id]/route.ts` (GET detail, stays `view_all_trips`): return `slaReasons` + `exceptionId` on events + `exceptions[]` + `alerts[]` in the `TripDetailView` (depends on T028)
- [X] T032 [P] Extend `apps/web/app/api/dashboard/summary/route.ts` (GET, stays `view_all_trips`): return the four filled metrics (`tripsAtRisk`, `activeExceptions`, `onTimePickupPct`, `onTimeArrivalPct`) (depends on T028)
- [X] T033 [P] Extend `NAV_ITEMS` in `apps/web/lib/nav.ts`: add **Exception Management** (`href:"/exceptions"`, permission `view_all_trips`) and **SLA Rules** admin (`href:"/sla-rules"`, permission `manage_commercial_data`) (depends on T001)
- [X] T034 [P] Extend `apps/web/messages/pt-BR.json`: `Exceptions` / `Alerts` / `Sla` namespaces (panel, Exception Management filters, SLA indicator/reason labels, alert surface, SLA-rule admin), the SLA "At risk" view + filter labels under `Trips.board` (`viewAtRisk`, `filterSlaStatus`), and the seven new audit actions BOTH nested under `Trips.auditActions` (`exception.create/update/resolve/cancel`, `trip.note`, `sla_rule.create/update`) AND flat under `AuditActions` (`exception_create`/…/`sla_rule_update`) — **no dotted keys** (depends on T005)

### Worker foundation (`@brazil-tms/workers`)

- [X] T035 Extend `workers/lib/queue.ts`: merge `SLA_JOBS` into the worker's `JOB` / `JobName` / `JobPayloads` surface (re-exported from `@brazil-tms/shared`) and into the `setupQueues` loop so the `sla.sweep` queue is created at bootstrap — per data-model §14 / R10 (depends on T011)
- [X] T036 [P] Add `SLA_SWEEP_CRON` (default `*/5 * * * *` — every 5 min) to `workers/.env` (local dev) and to the `worker` service `environment:` block in `infra/supabase/docker-compose.yml` — per data-model §14 / quickstart (depends on T001)

### Foundational tests (Vitest unit — pure, no DB)

- [X] T037 [P] Unit test `packages/shared/src/domain/sla-risk.test.ts`: `evaluateSlaRisk` over the D1 map × each of the 7 reasons, worst-state-wins (D2), no-planned-window branch, time-in-status branch, terminal/cancelled short-circuit, Breached-never-in-MVP, and the `DEFAULT_SLA_POLICY` magnitudes (depends on T002)
- [X] T038 [P] Unit test `packages/shared/src/domain/exceptions.test.ts`: `canTransitionException` over every legal/illegal edge (Open↔Monitoring; →Resolved/Cancelled; terminal no-reopen), and the `EXCEPTION_*` / `REASON_CODE_CATEGORIES` const shapes (5-value responsible-party incl. `force_majeure`) (depends on T003)
- [X] T039 [P] Create Vitest schema tests `packages/shared/src/schemas/{exception,customer-sla-rule,trip-event,alert}.test.ts`: required/optional fields, `z.enum` membership, `closureNotes`-required-on-Resolved `superRefine`, minute-integer ≥0, length caps (depends on T006, T007, T008, T009)
- [X] T040 [P] Extend `packages/shared/src/audit/actions.test.ts`: `ALL_AUDIT_ACTIONS` contains the seven new actions and stays in lockstep with the `AuditAction` union (depends on T005)
- [X] T041 [P] Extend `packages/shared/src/schemas/trip-board.test.ts`: the new `slaStatus`/`atRisk` params round-trip from `URLSearchParams` via `PARAM_KEYS` (depends on T010)
- [X] T042 [P] Extend `packages/shared/src/auth/permissions.test.ts`: `ROLE_PERMISSIONS`/`can` grant `update_trip_status` to Admin/Operations Manager/Dispatcher/Control Tower, `create_exceptions`/`resolve_exceptions` to those four + Fleet Coordinator, and `manage_commercial_data` to Admin/Operations Manager (permission-matrix.md test focus — no new key)

**Checkpoint**: Schema applied; shared domain + Zod + audit/jobs exported; SLA recompute engine + alert helpers + read-model extensions in place; the extended board/detail/dashboard read routes return SLA/exception/alert data; i18n + nav + worker queue wired; foundational unit tests green. User stories can now begin.

---

## Phase 3: User Story 1 - Record execution milestones and read the trip timeline (Priority: P1) 🎯 MVP

**Goal**: A dispatcher records each real-world milestone (At Origin → [Loading] → Loaded → In Transit → At Destination → [Unloading] → Unloaded → Completed) driven through 003's `transitionTripStatus` (status machine NOT redefined); every change auto-records a `trip_events` row (actor/source/timestamp/before-after) and recomputes SLA; free-form notes append without a status change; the Trip-Detail timeline becomes interactive with planned-vs-actual deltas.

**Independent Test**: On a `confirmed` trip, advance the milestone statuses as a `update_trip_status` holder → each transition creates a `trip_events` row (actor/source/timestamp/before-after) and `sla_status` recomputes; the timeline renders chronologically with planned-vs-actual deltas; a free-form note appears without changing status; an illegal jump is refused by 003's machine; a user lacking `update_trip_status` is refused `403`.

- [X] T043 [US1] Create `packages/db/src/trips/trip-events.ts` exporting `addTripNote(tripId, input, actorUserId): Promise<TripDetail>` — in one `db.transaction`: INSERT a `trip_events` row (`event_type='note'`, `source='operator_manual'`, `notes`, optional `location_id`/`exception_id`/`event_timestamp`, **no status change**), `writeAudit(tx, "trip.note", …)`, `recomputeTripSla(tx, tripId)`, return `loadTripDetail(tx, tripId)` — mirror `trip-transitions.ts`; add the export to `packages/db/src/index.ts` (depends on T023, T025, T027)
- [X] T044 [US1] Wire `recomputeTripSla` into the milestone path: after the in-tx transition commits in `transitionTripStatus` in `packages/db/src/trips/trip-transitions.ts`, call `recomputeTripSla(tx, tripId)` so a recorded milestone flips `sla_status`/`sla_reasons` immediately (terminal trips short-circuit inside recompute) (depends on T023)
- [X] T045 [P] [US1] Create `apps/web/lib/trips/trip-events.ts` as a `"server-only"` re-export of `{ addTripNote }` from `@brazil-tms/db` (mirror `apps/web/lib/trips/trip-transitions.ts`) (depends on T043)
- [X] T046 [US1] Create the POST handler `apps/web/app/api/trips/[id]/status/route.ts` (record milestone): `requireAuth` → `requirePermission(ctx,"update_trip_status")` → `transitionTripSchema.parse(body)` → `transitionTripStatus(id, input, ctx.userId)` → `NextResponse.json({ item })`; `try/catch handleRouteError`; `export const dynamic="force-dynamic"`; export only the POST handler (the milestone set drives the existing `confirmed→…→completed` edges incl. optional `loading`/`unloading` as `status_change`) (depends on T044)
- [X] T047 [US1] Create the POST handler `apps/web/app/api/trips/[id]/events/route.ts` (free-form note): same auth shape with `requirePermission(ctx,"update_trip_status")` + `addTripNoteSchema.parse` → `addTripNote(id, input, ctx.userId)` → `{ item }` (depends on T045)
- [X] T048 [US1] Extend `apps/web/lib/trips/client.ts` with `useRecordMilestone(id)` + `useAddTripNote(id)` mutation hooks (POST the two routes via `asJson`; `onSuccess` invalidate the `["trips"]` root; map error codes via `TripsError`) — follow `useUpdateTripPlan`; reuse the 005 poll constants (depends on T046, T047)
- [X] T049 [US1] Upgrade `apps/web/components/trips/trip-detail/timeline.tsx` from read-only to **interactive**: milestone-recording controls (next legal statuses, wired to `useRecordMilestone`), a free-form note entry (`useAddTripNote`), chronological event list with **planned-vs-actual** deltas (planned pickup/delivery windows vs recorded `eventTimestamp`), pt-BR labels + error mapping (depends on T048, T034)
- [X] T050 [P] [US1] Integration test `apps/web/lib/trips/trip-events.test.ts` (Vitest, static imports, `describe.skipIf(!DATABASE_URL)`, own seed + FK-safe cleanup): `addTripNote` → one `note` `trip_events` row, **no** status change, `trip.note` audit, `recomputeTripSla` ran; and a milestone via `transitionTripStatus` records a `status_change` row AND drives `recomputeTripSla` (depends on T043, T044, T020)
- [X] T051 [P] [US1] Playwright e2e `apps/web/e2e/execution-timeline.spec.ts` (`apiLogin` as Ops Manager/Dispatcher): advance milestones from the interactive timeline → status changes + chronological timeline with planned-vs-actual; add a note → appears without status change; illegal jump (Loaded before At Origin) → `ILLEGAL_TRANSITION`; a user without `update_trip_status` → `403` (depends on T046, T047, T049)

**Checkpoint**: US1 fully functional and independently testable — the execution-tracking walking skeleton; SLA flips on milestone recording.

---

## Phase 4: User Story 2 - Log, monitor, and resolve exceptions (Priority: P1)

**Goal**: A user creates an exception (reason code suggests default severity + responsible party; owner defaults to creator; category derived from the reason code), works it Open→Monitoring→Resolved/Cancelled (terminal, closure notes on Resolved), and sees it on Trip Detail + a filterable Exception Management queue. A high-severity exception generates its alert synchronously and recomputes SLA.

**Independent Test**: Create an exception with a reason code → defaults pre-fill, saved Open + `opened_at` + owner=creator, category derived; transition Open→Monitoring→Resolved with closure notes → `resolved_at` set, terminal (no reopen); appears in Exception Management filterable by severity/customer/lane/reason/owner/age; a user without `create_exceptions` cannot open and without `resolve_exceptions` cannot resolve → `403`.

- [X] T052 [US2] Implement `createException(tripId, input, actorUserId): Promise<TripDetail>` in `packages/db/src/trips/exceptions.ts` mirroring `transitionTripStatus`: resolve the active reason code (unknown/inactive ⇒ `Conflict("INVALID_REASON_CODE")`), pre-fill `severity`/`responsible_party` from its defaults (overridable), default `owner_user_id` to the actor; in one tx INSERT the `exceptions` row (`status='open'`, `opened_at=now`), `writeAudit("exception.create")`, when `severity='high'` call `generateAlert(tx, tripId, 'high_severity_exception', 'high')`, then `recomputeTripSla(tx, tripId)`, return `loadTripDetail(tx, tripId)` (depends on T023, T024, T025)
- [X] T053 [US2] Implement `updateException(exceptionId, input, actorUserId): Promise<TripDetail>` in `packages/db/src/trips/exceptions.ts`: edit owner/severity/responsible-party/description on a non-terminal exception in one tx + `writeAudit("exception.update")`, then `recomputeTripSla` (a severity flip to/from `high` adds via `generateAlert` or `autoResolveAlert` the high-severity alert), return `loadTripDetail` (depends on T052)
- [X] T054 [US2] Implement `transitionException(exceptionId, input, actorUserId): Promise<TripDetail>` in `packages/db/src/trips/exceptions.ts`: pre-tx `canTransitionException(from,to)` (illegal ⇒ `Conflict("ILLEGAL_EXCEPTION_TRANSITION")`); in one tx guarded `UPDATE … WHERE status = expectedFromStatus` (0 rows ⇒ `Conflict("STALE_EXCEPTION")`); on `resolved` set `resolved_at`+persist `closure_notes`; `writeAudit("exception.resolve" | "exception.cancel" | "exception.update")`; `recomputeTripSla` + `autoResolveAlert(tx, tripId, 'high_severity_exception')` when a high-sev exception closes; return `loadTripDetail`; export `createException`/`updateException`/`transitionException` from `packages/db/src/index.ts` (depends on T053)
- [X] T055 [P] [US2] Create `apps/web/lib/trips/exceptions.ts` as a `"server-only"` re-export of `{ createException, updateException, transitionException, queryExceptions, queryReasonCodes }` from `@brazil-tms/db` (depends on T054, T027)
- [X] T056 [P] [US2] Create the POST handler `apps/web/app/api/trips/[id]/exceptions/route.ts` (create): `requirePermission(ctx,"create_exceptions")` + `createExceptionSchema.parse` → `createException(id, input, ctx.userId)` → `201 { item }`; export only POST + `dynamic` (depends on T055)
- [X] T057 [P] [US2] Create the PATCH handler `apps/web/app/api/exceptions/[id]/route.ts` (edit): `requirePermission(ctx,"resolve_exceptions")` + `updateExceptionSchema.parse` → `updateException` → `{ item }` (depends on T055)
- [X] T058 [P] [US2] Create the POST handler `apps/web/app/api/exceptions/[id]/transition/route.ts` (lifecycle): `requirePermission(ctx,"resolve_exceptions")` + `transitionExceptionSchema.parse` → `transitionException` → `{ item }` (`409 ILLEGAL_TRANSITION`/`STALE_EXCEPTION`) (depends on T055)
- [X] T059 [P] [US2] Create the GET handler `apps/web/app/api/exceptions/route.ts` (Exception Management list): `requirePermission(ctx,"view_all_trips")` + `exceptionFilterSchema.parse(query)` → `queryExceptions(filters)` → `{ items }` (severity/customer/lane/reason/owner/age) (depends on T055)
- [X] T060 [P] [US2] Create the GET handler `apps/web/app/api/reason-codes/route.ts` (active reason codes for the create form): `requirePermission(ctx,"view_all_trips")` → `queryReasonCodes()` → `{ items }` (depends on T055)
- [X] T061 [US2] Extend `apps/web/lib/trips/client.ts` with `useCreateException(id)`/`useUpdateException`/`useTransitionException` mutation hooks (invalidate `["trips"]`) + `useExceptions(filters)`/`useReasonCodes()` query hooks (depends on T056, T057, T058, T059, T060)
- [X] T062 [US2] Create `apps/web/components/trips/trip-detail/exception-panel.tsx` (replaces `ExceptionPlaceholder`): the trip's exception list + a create form (reason-code picker with defaults pre-fill, severity/responsible-party/owner/description) + Monitor/Resolve/Cancel transition actions (closure-notes prompt on Resolve), wired to the US2 hooks, pt-BR labels/error mapping (depends on T061, T031, T034)
- [X] T063 [US2] Wire `<ExceptionPanel … />` into `apps/web/components/trips/trip-detail/trip-detail-client.tsx` in place of `<ExceptionPlaceholder />`, and remove `ExceptionPlaceholder` (+ its key-union members) from `apps/web/components/trips/trip-detail/placeholders.tsx` (leave the Documents/Billing placeholders untouched) (depends on T062)
- [X] T064 [US2] Create the Exception Management screen `apps/web/app/(shell)/exceptions/page.tsx` (server guard `view_all_trips`, loads filter options) + `apps/web/components/exceptions/exception-table.tsx` + `apps/web/components/exceptions/exception-filters.tsx` (severity/customer/lane/reason/owner/age via `useExceptions`, TanStack Table, pt-BR, 30 s polling) (depends on T061, T028)
- [X] T065 [P] [US2] Integration test `apps/web/lib/trips/exceptions.test.ts` (static imports, `skipIf(!DATABASE_URL)`): `createException` (defaults pre-fill, owner defaults to actor, `INVALID_REASON_CODE`, `exception.create` audit, high-sev `generateAlert` fires + recompute → At Risk, and `responsible_party` (incl. `force_majeure`) + the derived category are persisted/readable for downstream billing-dispute consumption — FR-012); `updateException`; `transitionException` (`STALE_EXCEPTION`, `ILLEGAL_EXCEPTION_TRANSITION`, closure-notes-required-on-Resolved sets `resolved_at`, terminal no-reopen, high-sev close auto-resolves its alert + recompute) (depends on T052, T053, T054, T020)
- [X] T066 [P] [US2] Integration test `apps/web/lib/trips/exceptions-read.test.ts`: `queryExceptions` filters (severity/customer-via-trip/lane-via-trip/reason/owner/age=`opened_at`) and the derived category join through `reason_code_id`; `queryReasonCodes` returns active rows ordered by `sort_order` (depends on T026, T020, T021)
- [X] T067 [P] [US2] Playwright e2e `apps/web/e2e/exceptions.spec.ts` (`apiLogin`): create an exception (defaults pre-fill, 5-value responsible party incl. force majeure) → Open→Monitoring→Resolved with closure notes → terminal; Exception Management filters narrow the list; `create_exceptions`/`resolve_exceptions` holder `200` vs non-holder `403`; audit shows `exception.create`/`exception.resolve` (depends on T056, T057, T058, T059, T062, T064)

**Checkpoint**: US1 + US2 together = execution tracking with a full exception lifecycle and the high-severity-exception SLA/alert trigger live.

---

## Phase 5: User Story 3 - See server-computed SLA risk on the control tower (Priority: P1)

**Goal**: Per-trip server-authoritative SLA-risk state (On Track / At Risk / Late / Breached) + contributing reasons surface on the board, the "At risk" view, Trip Detail, and the dashboard at-risk count — recomputed on relevant changes (milestone/exception/assignment/confirmation) AND by the first scheduled worker sweep for purely time-based triggers; never computed client-side.

**Independent Test**: Seed trips covering each of the seven triggers; assert each trip's `sla_status` + `sla_reasons` match the D1 map (window-miss⇒Late; the other five⇒At Risk; worst-state-wins; Breached never); the board/"At risk" view/Trip Detail/dashboard count reflect them via polling; the worker sweep flips a passed-cutoff trip with no user action; terminal trips are not evaluated.

- [X] T068 [US3] Wire on-change recompute into the 006 assignment/confirmation services in `packages/db/src/trips/trip-assignments.ts`: call `recomputeTripSla(tx, tripId)` inside the existing transactions of `assignTrip` / `reassignTrip` / `unassignTrip` / `confirmTripAssignment` so `missing_assignment` / `missed_confirmation` reasons clear/fire immediately (FR-017/FR-019, read-only inputs) (depends on T023)
- [X] T069 [US3] Create `workers/jobs/sla-sweep/index.ts` exporting `runSlaSweep(payload)` + `registerSlaSweep(boss)` (mirror the import-job convention): over **active (non-terminal) trips only** (`ACTIVE_TRIP_STATUSES`), in **chunks** (≤200/batch), per trip in its own tx with `SELECT … FOR UPDATE` + **try/catch fault isolation** (skip-and-continue, log, never abort) call `recomputeTripSla`; emit a structured per-sweep summary log (`duration_ms`, `evaluated`, `changed`, `errors`) + heartbeat; `registerSlaSweep` calls `boss.schedule(SLA_JOBS.slaSweep, process.env.SLA_SWEEP_CRON ?? '*/5 * * * *', {}, opts)` (alert generation is added in US4) (depends on T023, T035)
- [X] T070 [US3] Register the sweep in `workers/jobs/index.ts` (`await registerSlaSweep(boss)` in `registerJobHandlers`) so the existing single worker process schedules its **first** cron job at bootstrap (depends on T069)
- [X] T071 [P] [US3] Create `apps/web/components/trips/trip-detail/sla-indicator.tsx` (replaces the SLA placeholder): renders `slaStatus` + `slaReasons` (pt-BR labels, severity colour), and remove the SLA placeholder from `apps/web/components/trips/trip-detail/placeholders.tsx`; wire it into `trip-detail-client.tsx` (depends on T031, T034)
- [X] T072 [P] [US3] Add the SLA-risk row indicator/column to `apps/web/components/trips/control-tower-table.tsx` (render `slaStatus`/`slaReasons` from `TripBoardRow`) (depends on T030)
- [X] T073 [US3] Add the `slaStatus`/`atRisk` filter control to `apps/web/components/trips/trip-filters.tsx` and surface the `"at_risk"` view preset (sourced from `views.ts`), wired through the board URL-state in `apps/web/lib/trips/client.ts` (depends on T029, T030, T072)
- [X] T074 [P] [US3] Wire `apps/web/components/trips/dashboard/widgets.tsx` to render the `tripsAtRisk` count (deep-link to the `"at_risk"` view) + `onTimePickupPct`/`onTimeArrivalPct` once the read model returns numbers (the `metric()` helper auto-flips placeholder→value) (depends on T032, T029)
- [X] T075 [P] [US3] Integration test `apps/web/lib/trips/sla.test.ts` (static imports, `skipIf(!DATABASE_URL)`): `recomputeTripSla` writes the correct `sla_status`+`sla_reasons` for each trigger (assignment/confirmation/origin/destination/loading/departure/high-sev), worst-state-wins across multiple triggers, Breached never, terminal short-circuit (no write), and resolves the applicable `customer_sla_rules` row vs `DEFAULT_SLA_POLICY` (atomic write) (depends on T023, T020, T022)
- [X] T076 [P] [US3] Worker test `workers/jobs/sla-sweep/sla-sweep.test.ts` (`skipIf(!DATABASE_URL)`): `runSlaSweep` recomputes `sla_status`/`sla_reasons` over active trips only (terminal skipped), per-trip fault isolation (one bad trip is skipped, the sweep continues), chunking, and the per-sweep summary fields (depends on T069, T020)
- [X] T077 [US3] Playwright e2e `apps/web/e2e/sla-risk.spec.ts` (`apiLogin`): drive trips into each trigger → board row indicator + "At risk" view + Trip-Detail SLA indicator + dashboard at-risk count reflect `sla_status`/`sla_reasons` (worst-state-wins, all reasons listed); the same answer comes from the server (UI never computes); Breached never appears (depends on T071, T072, T073, T074)

**Checkpoint**: SLA-risk visibility is live and server-authoritative — the headline outcome; the first scheduled worker job is sweeping.

---

## Phase 6: User Story 4 - Receive in-app alerts for the MVP cases (Priority: P2)

**Goal**: The worker generates in-app alerts for the six in-scope §17 cases (the five time-based cases on the sweep + the synchronous high-severity-exception case from US2), idempotently (one per trip+case while active/acknowledged), auto-resolving cleared conditions; alerts surface on the board/dashboard and are acknowledgeable; nothing leaves the app.

**Independent Test**: Drive trips into each of the six conditions → run the sweep → exactly one alert per (trip, case), no duplicate on re-run; alerts surface in-app and feed the dashboard count; acknowledging removes it from the active list and it is not re-spammed while still true; clearing the condition auto-resolves the row and a later recurrence makes a fresh alert; no external channel is invoked; the two document/billing cases produce nothing.

- [X] T078 [US4] Extend `runSlaSweep` in `workers/jobs/sla-sweep/index.ts` to generate + auto-resolve the five **time-based** alert cases per trip (`unassigned_within_window`, `unconfirmed_within_window`, `missed_origin_arrival`, `missed_departure`, `missed_destination_arrival`) via `generateAlert` (`ON CONFLICT DO NOTHING`) when the condition holds and `autoResolveAlert` when it clears, inside the same per-trip tx; **also act as the `high_severity_exception` backstop** (R10/R11) — when `openHighSeverityExceptionCount > 0` call `generateAlert(tx, tripId, 'high_severity_exception', 'high')` (idempotent with the synchronous create in T052) and when it returns to 0 call `autoResolveAlert(tx, tripId, 'high_severity_exception')`, so the alert heals if the synchronous path ever missed it; add `alerts_created`/`alerts_resolved` to the summary log; the two deferred cases (008/009) emit nothing (depends on T069, T024)
- [X] T079 [US4] Add `acknowledgeAlert(alertId, actorUserId): Promise<AlertDto>` to `packages/db/src/trips/alerts.ts` (`UPDATE … SET state='acknowledged', acknowledged_by_user_id, acknowledged_at WHERE state IN ('active','acknowledged')`; already-`resolved` ⇒ `Conflict("STALE_ALERT")`; NOT an `AuditAction`) and export it from `packages/db/src/index.ts` (depends on T024, T027)
- [X] T080 [P] [US4] Create `apps/web/lib/trips/alerts.ts` as a `"server-only"` re-export of `{ listAlerts, acknowledgeAlert }` from `@brazil-tms/db` (depends on T079)
- [X] T081 [P] [US4] Create the GET handler `apps/web/app/api/alerts/route.ts` (active/acknowledged list + counts): `requirePermission(ctx,"view_all_trips")` + optional `state`/`tripId` query → `listAlerts` → `{ items, counts }` (resolved rows excluded) (depends on T080)
- [X] T082 [P] [US4] Create the POST handler `apps/web/app/api/alerts/[id]/acknowledge/route.ts`: `requirePermission(ctx,"view_all_trips")` (read-surface triage — no write key) + `acknowledgeAlertSchema.parse` → `acknowledgeAlert(id, ctx.userId)` → `{ item }` (`409 STALE_ALERT`) (depends on T080)
- [X] T083 [US4] Extend `apps/web/lib/trips/client.ts` with `useAlerts(filters)` query hook + `useAcknowledgeAlert()` mutation (invalidate `["alerts"]` and `["trips"]`); add an `["alerts"]` query root on the board/30 s cadence (depends on T081, T082)
- [X] T084 [US4] Create `apps/web/components/alerts/alert-surface.tsx` (in-app alert list + acknowledge action, per-case/severity counts, pt-BR) and mount it on the Control-Tower board + Home Dashboard; wire the dashboard alert count widget in `apps/web/components/trips/dashboard/widgets.tsx` (depends on T083)
- [X] T085 [P] [US4] Integration test `apps/web/lib/trips/alerts.test.ts` (static imports, `skipIf(!DATABASE_URL)`): `generateAlert` idempotency (second call while active/acknowledged ⇒ no duplicate via the partial-unique `ON CONFLICT`); `autoResolveAlert` on clear; `acknowledgeAlert` (state→acknowledged, then `STALE_ALERT` on a resolved row); an acknowledged-but-still-true alert is not regenerated; a recurrence after resolve inserts a fresh row (depends on T079, T020)
- [X] T086 [P] [US4] Worker test `workers/jobs/sla-sweep/alerts.test.ts` (`skipIf(!DATABASE_URL)`): the six in-scope cases generate one alert each; a re-run while conditions persist creates no duplicate; the **full clear→re-fire cycle through `runSlaSweep`** for ≥1 time-based case (condition true ⇒ one active row → condition clears ⇒ sweep auto-resolves → condition recurs ⇒ next sweep inserts a fresh active row, prior stays resolved); the worker **backstop** re-creates a missing `high_severity_exception` alert and auto-resolves it when the last high-sev exception closes; the two deferred cases (`completed_missing_documents`, `billing_blocked_missing_proof`) emit nothing (depends on T078, T020)
- [X] T087 [US4] Playwright e2e `apps/web/e2e/alerts.spec.ts` (`apiLogin`): alerts surface on board/dashboard with counts; acknowledge removes from the active list + updates the count; a high-severity exception (US2) creates its alert immediately; assert **no** external channel is invoked and the two deferred cases produce nothing (depends on T081, T082, T084)

**Checkpoint**: The proactive alert layer is live in-app on top of the SLA-risk state.

---

## Phase 7: User Story 5 - Configure per-customer SLA rules (Priority: P2)

**Goal**: An Operations Manager (`manage_commercial_data`) configures per-customer SLA rules (pickup/delivery tolerances, confirmation cutoff, at-risk warning window; optional lane/vehicle-type scope + effective dates); the evaluator uses them with precedence lane > vehicle-type > customer-default (tie-break latest `effective_start`), and a customer with no rule runs on `DEFAULT_SLA_POLICY` and is reported SLA sign-off blocked.

**Independent Test**: Create a customer SLA rule → that customer's trips evaluate against it while others fall back to defaults; a customer with no rule is reported SLA sign-off blocked; overlapping scopes resolve by precedence; a user without `manage_commercial_data` cannot edit → `403`.

- [X] T088 [US5] Create `packages/db/src/trips/sla-rules.ts` exporting `createCustomerSlaRule(input, actorUserId)` and `updateCustomerSlaRule(id, input, actorUserId)` (one tx each + `writeAudit("sla_rule.create" | "sla_rule.update")`; `NOT_FOUND` on missing customer/lane/rule) — the precedence resolution + default fallback already live in `recomputeTripSla` (T023); export both from `packages/db/src/index.ts` (depends on T023, T027)
- [X] T089 [P] [US5] Create `apps/web/lib/trips/sla-rules.ts` as a `"server-only"` re-export of `{ createCustomerSlaRule, updateCustomerSlaRule, queryCustomerSlaRules }` from `@brazil-tms/db` (depends on T088, T027)
- [X] T090 [P] [US5] Create the GET/POST handlers `apps/web/app/api/customer-sla-rules/route.ts`: GET `view_all_trips` → `queryCustomerSlaRules` → `{ items }`; POST `manage_commercial_data` + `createSlaRuleSchema.parse` → `createCustomerSlaRule` → `201 { item }` (depends on T089)
- [X] T091 [P] [US5] Create the PATCH handler `apps/web/app/api/customer-sla-rules/[id]/route.ts`: `requirePermission(ctx,"manage_commercial_data")` + `updateSlaRuleSchema.parse` → `updateCustomerSlaRule` → `{ item }` (depends on T089)
- [X] T092 [US5] Extend `apps/web/lib/trips/client.ts` with `useCustomerSlaRules()` query hook + `useCreateSlaRule()`/`useUpdateSlaRule()` mutation hooks (invalidate `["sla-rules"]` and `["trips"]`) (depends on T090, T091)
- [X] T093 [US5] Create the SLA-rule admin screen `apps/web/app/(shell)/sla-rules/page.tsx` (server guard — redirect non-`manage_commercial_data` users; loads customers/lanes options) + `apps/web/components/sla-rules/sla-rule-admin.tsx` (list + create/edit form: tolerances/cutoff/warning, optional lane/vehicle-type scope, effective dates; pt-BR; surfaces "SLA sign-off blocked" for customers with no rule) (depends on T092, T028)
- [X] T094 [P] [US5] Integration test `apps/web/lib/trips/sla-rules.test.ts` (static imports, `skipIf(!DATABASE_URL)`): `createCustomerSlaRule`/`updateCustomerSlaRule` (+ `sla_rule.create`/`sla_rule.update` audit); precedence resolution via `recomputeTripSla` (lane > vehicle-type > customer-default, tie-break latest `effective_start`); a customer with no matching row evaluates on `DEFAULT_SLA_POLICY` and is reported SLA sign-off blocked; a rule outside its `effective_start`/`effective_end` window is NOT selected (falls back to defaults) (depends on T088, T020, T022)
- [X] T095 [US5] Playwright e2e `apps/web/e2e/sla-rules.spec.ts` (`apiLogin` as Ops Manager): create + edit a customer SLA rule → that customer's trips evaluate against it, others fall back to defaults; a no-rule customer shows SLA sign-off blocked; `manage_commercial_data` holder `200` vs non-holder `403`; audit shows `sla_rule.create`/`sla_rule.update` (depends on T090, T091, T093)

**Checkpoint**: All five user stories independently functional; SLA evaluation is per-customer-configurable with an explicit default + blocked sign-off.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T096 [P] Add the no-dotted-key + audit-action completeness assertions for the seven new actions to `apps/web/lib/messages.test.ts` (every `ALL_AUDIT_ACTIONS` entry has a flat `AuditActions` key via `action.replaceAll(".","_")`; the nested `Trips.auditActions.{exception,trip,sla_rule}` entries resolve; no key contains `.`) (depends on T034, T005)
- [X] T097 Run `pnpm exec vitest run --project web apps/web/lib/messages.test.ts` and fix any missing/dotted-key failures in `apps/web/messages/pt-BR.json` (a dotted i18n key breaks ALL authenticated page renders) (depends on T096)
- [X] T098 [P] Authz matrix e2e `apps/web/e2e/execution-authz.spec.ts` (`apiLogin`): `update_trip_status` holder `200` vs non-holder `403` on status/note; `create_exceptions`/`resolve_exceptions` holder `200` vs non-holder `403` on exception create/edit/transition; `manage_commercial_data` holder `200` vs non-holder `403` on SLA-rule create/update; view-only roles read (`GET /api/trips`, `/api/trips/:id`, `/api/exceptions`, `/api/alerts`, `/api/dashboard/summary` → `200`) **and acknowledge alerts** via `view_all_trips`; unauthenticated → `401` (depends on T046, T047, T056, T057, T058, T082, T090, T091)
- [X] T099 [P] Add a performance-sanity note to `specs/007-execution-events-exceptions/quickstart.md`: the pure evaluator sub-ms/trip + negligible on-change recompute; Exception Management list + board/"At risk" view `< ~3 s` at medium scale via the new indexes; the ~5-min sweep over low-thousands chunked trips completes well inside cadence (verify via the per-sweep summary log) — manual spot-check, not a perf harness (validates SC-010) (depends on T069, T078, T064)
- [X] T100 Run the quickstart.md US1–US5 validation against a fresh build with both the app and the worker running (`pnpm db:seed` + `db:seed:master-data` + `db:seed:trip-domain` + `db:seed:reason-codes` + `db:seed:sla-rules`, then `db:seed:e2e` to reset accounts) (depends on T051, T067, T077, T087, T095)
- [X] T101 Run the quality gates from repo root and fix failures: `pnpm lint`; `pnpm typecheck`; `pnpm build`; `pnpm test` (with `DATABASE_URL` set; web integration via `pnpm exec vitest run --project web`; e2e against a prod build, `--workers=1`) — targeting the `dev` branch (depends on T097, T100)
- [X] T102 Open the 007 PR to `dev` via `gh pr create --base dev` using the PR template, noting: first enforcement of `update_trip_status`/`create_exceptions`/`resolve_exceptions` + reuse of `manage_commercial_data`; four new tables + three enums + the `note` event-type member + the **first scheduled worker job** (no new permission key/package/worker process); `trip_events` stays append-only; and the gated/deferred items (per-customer SLA rules §29 #2 + per-customer SLA sign-off blocked, per-milestone planned times → time-in-status default, §17 alert cases 7–8 → 008/009, exception/event attachments → 008) — AI does NOT merge to `main` (depends on T101)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (T001)**: none.
- **Foundational (T002–T042)**: depends on Setup — BLOCKS all user stories. Internal order: shared domain/jobs/audit/schemas (T002–T010) before the shared barrel (T011); the enum extend + four schema files (T012–T016) before the schema barrel (T019) before generate/apply migration (T020); seeds (T021–T022) after the migration; the SLA engine + alert helpers + read-model extensions (T023–T026) after the migration, then the db barrel (T027); web read-route extends + nav + i18n (T028–T034) after their db/shared deps; worker queue wiring (T035–T036); foundational unit tests (T037–T042) after the code they cover.
- **US1 (T043–T051, P1)**: after Foundational. The execution-tracking MVP.
- **US2 (T052–T067, P1)**: after Foundational (uses `recomputeTripSla` T023, `generateAlert`/`autoResolveAlert` T024, `loadTripDetail` T025, `queryExceptions`/`queryReasonCodes` T026).
- **US3 (T068–T077, P1)**: after Foundational (SLA engine + read models) and after US2 (the high-sev-exception trigger is one of the seven); the worker sweep needs T023/T035.
- **US4 (T078–T087, P2)**: after US3 (extends `runSlaSweep` T069) and Foundational (alert helpers T024).
- **US5 (T088–T095, P2)**: after Foundational (precedence resolution lives in `recomputeTripSla` T023; `queryCustomerSlaRules` T026).
- **Polish (T096–T102)**: after the stories it validates.

### Story Independence

- US1 is independently shippable (execution tracking + interactive timeline). US2 adds the exception lifecycle (and the high-severity SLA/alert trigger). US3 (SLA visibility) reads US1/US2 inputs + 006 assignment state but is independently testable by seeding each trigger. US4 (alerts) is a thin generation+surface layer on US3's sweep. US5 (SLA rules) parameterizes US3's evaluator. Each adds value without breaking earlier stories.

### Parallel Opportunities

- **Foundational**: T002–T010 (different shared files) run in parallel; T013/T015 parallel, then T014→T018 (FK order) and T016 serialize on T012; T019→T020 (barrel→migration) serialize; T021/T022 parallel after T020; T023/T024 parallel after T020, T025/T026 then T027; T028–T034 parallelize once their deps land; T037–T042 (unit tests) all parallel.
- Service-file tasks that touch `packages/db/src/trips/exceptions.ts` (T052, T053, T054) are **sequential** (same file); the `apps/web/lib/trips/client.ts` extensions (T048, T061, T083, T092) are **sequential** (same file); the trip-detail placeholders/`trip-detail-client.tsx` edits (T063, T071) are **sequential**.
- **US1**: T046 ∥ T047 (different route files); T050 ∥ T051 (different test files) after their impl deps.
- **US2**: T056–T060 (different route files) parallel after T055; T065 ∥ T066 ∥ T067 after their impl deps.
- **US4**: T081 ∥ T082 (different route files); T085 ∥ T086 (different test files).
- **US5**: T090 ∥ T091 (different route files); T094 independent.
- Different user stories can be staffed in parallel once Foundational completes (mind the shared-file serializations above).

---

## Parallel Example: Foundational shared layer

```bash
# Different shared files — launch together:
Task: "Pure SLA evaluator packages/shared/src/domain/sla-risk.ts"        # T002
Task: "Exception lifecycle packages/shared/src/domain/exceptions.ts"      # T003
Task: "SLA job contract packages/shared/src/sla/jobs.ts"                  # T004
Task: "Audit actions extend packages/shared/src/audit/actions.ts"         # T005
Task: "Zod schemas trip-event/exception/customer-sla-rule/alert"          # T006–T009
Task: "trip-board schema extend (slaStatus/atRisk + PARAM_KEYS)"          # T010
```

---

## Implementation Strategy

### MVP First

1. Complete Phase 1 (Setup) + Phase 2 (Foundational).
2. Complete Phase 3 (US1) → **STOP and VALIDATE**: milestones recordable, timeline interactive with planned-vs-actual, SLA flips on milestone. Execution-tracking walking skeleton.
3. Complete Phase 4 (US2) + Phase 5 (US3) → exceptions + server-authoritative SLA risk visible (the three P1 stories). **Recommended MVP boundary** — the "update statuses, log exceptions, at-risk indicators" Phase-3 exit bar (§23).

### Incremental Delivery

US4 (in-app alerts) → US5 (per-customer SLA rules) → Polish (i18n guard / authz matrix / perf / quickstart / quality gates / PR). Each story is demoable and independently testable.

### Parallel Team Strategy

After Foundational: one developer takes US1, another US2; US3 follows once US2's high-sev trigger lands; US4 follows US3's sweep; US5 is independent of US1/US2/US4 (touches SLA-rule files only). Respect the shared-file serializations (`exceptions.ts`, `client.ts`, trip-detail components).

---

## Notes

- Tests are included (required by plan Testing / Constitution §3.13 / quickstart). Pure correctness → Vitest `packages/shared` unit (the SLA evaluator + exception lifecycle + Zod); services + read models + worker sweep → Vitest integration with `DATABASE_URL` (static imports, `skipIf(!DATABASE_URL)`); HTTP statuses (401/403/400/404/409) + finding/error payloads + UI flows + the authz matrix → Playwright `e2e/` (the project has **no** `route.test.ts` — web Vitest only includes `lib/**`).
- `[P]` = different files, no incomplete dependency. The three exception-service bodies share `exceptions.ts`, the four `client.ts` extensions share one file, and the trip-detail placeholder/client edits share files — kept sequential.
- **No new permission key** (first-enforce `update_trip_status`/`create_exceptions`/`resolve_exceptions`, reuse `manage_commercial_data`; reads + alert acknowledge stay on `view_all_trips`), **no new package**, **no new worker process** (the 004 worker gains its first scheduled job). Four new tables; three enums; `sla_status` stays `text`+CHECK (no enum, D4); one new `trip_event_type` member (`note`, D5).
- SLA/alert authority is server-side (the pure evaluator the BFF + worker call — the UI never computes); `trip_events` stays append-only; exceptions/alerts/rules mutate but are never hard-deleted (a recurrence is a new exception; alerts auto-resolve); freshness is polling (no Realtime); UI is pt-BR with no dotted i18n keys; timestamps UTC.
- Gated/deferred (configurable defaults, not invented — Constitution II): per-customer SLA rules (§29 #2 — defaults + per-customer SLA sign-off blocked), per-milestone planned times (time-in-status 120-min default), §17 alert cases 7–8 (008/009), exception/event attachments (008).
- Commit after each task or logical group; AI does not merge to `main` (PRs target `dev`).
```
