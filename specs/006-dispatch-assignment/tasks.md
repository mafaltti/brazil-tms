# Tasks: Dispatch Assignment and Conflict Warnings

**Input**: Design documents from `/specs/006-dispatch-assignment/`
**Prerequisites**: plan.md (required), spec.md (user stories US1–US5), research.md (R0–R15), data-model.md, contracts/ (bff-endpoints.md, permission-matrix.md)
**Tests**: INCLUDED — explicitly required by the plan's Testing section, Constitution §3.13 (assignment-conflict checks, status transitions, permission checks), and quickstart.md.

**Organization**: Tasks are grouped by user story so each story is independently implementable and testable. Setup → Foundational (blocking) → US1 (P1) → US2 (P1) → US3 (P2) → US4 (P2) → US5 (P2) → Polish.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1..US5 for story-phase tasks (Setup / Foundational / Polish have no story label)
- Exact repo-relative file paths are in each description

## Path Conventions

Existing monorepo (per plan.md Project Structure): `packages/shared/src/`, `packages/db/{schema,src,migrations}/`, `apps/web/`. No new package/worker. One new table (`trip_assignments`); no new enum/permission key. Conflict authority is server-side; freshness is polling; UI is pt-BR.

---

## Phase 1: Setup

**Purpose**: Branch off `dev` for the slice.

- [X] T001 Create the short-lived feature branch `006-dispatch-assignment` off `dev` (`git checkout -b 006-dispatch-assignment dev`)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared schema, domain logic, services, read-model extensions, and read-route passthroughs that ALL user stories depend on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Shared (`@brazil-tms/shared`)

- [X] T002 [P] Extend the `AuditAction` union AND `ALL_AUDIT_ACTIONS` in `packages/shared/src/audit/actions.ts` with `trip.assign` / `trip.reassign` / `trip.unassign` / `trip.confirm` (keep both in lockstep so the `satisfies` check passes)
- [X] T003 [P] Extend `TRIP_CRITICAL_FIELDS` in `packages/shared/src/domain/trip-status.ts` with `assignedDriverId` / `assignedVehicleId` / `assignedTrailerId` / `assignedCarrierId` (the file comment reserves this for 006)
- [X] T004 [P] Create the pure evaluator in `packages/shared/src/domain/assignment-eligibility.ts`: `evaluateAssignmentEligibility(ctx, policy): Finding[]`, `DEFAULT_ASSIGNMENT_POLICY` (confirmed company-default block/warn map per data-model §3.2), `requiredResourcesFor(ownership)`, `ASSIGNMENT_TURNAROUND_BUFFER_MINUTES = 0`, and the `Finding` / `Severity` / `AssignmentCheck` / `EligibilityContext` / `AssignmentPolicy` types
- [X] T005 [P] Create `packages/shared/src/schemas/trip-assignment.ts` exporting `assignTripSchema` / `confirmAssignmentSchema` / `checkAssignmentSchema` (driverId/vehicleId uuid; trailerId/carrierId nullable-optional uuid; `expectedFromStatus` `z.enum(TRIP_STATUSES)`; notes/overrideReason `≤2000`) — mirror `transitionTripSchema`
- [X] T006 [P] Extend the board query schema in `packages/shared/src/schemas/trip-board.ts` with `assigned` (`'true'|'false'`), `driverId`, `vehicleId`, `carrierId` — add each to the `z.object` AND to `PARAM_KEYS` (a param missing from `PARAM_KEYS` silently never parses from the URL)
- [X] T007 Add `export *` lines to `packages/shared/src/index.ts` for `./domain/assignment-eligibility` and `./schemas/trip-assignment` (depends on T004, T005)

### Database (`@brazil-tms/db`)

- [X] T008 Create `packages/db/schema/trip-assignments.ts`: the `trip_assignments` pgTable (inline FKs to trips/drivers/vehicles/trailers/carriers/users; `is_current`; `superseded_by_assignment_id`/`superseded_at`; `assigned_by/at`, `confirmed_by/at`; `notes`, `override_reason`) with `uniqueIndex("trip_assignments_trip_active_uq").on(tripId).where(is_current)`, `trip_assignments_trip_idx`, and the four partial conflict indexes (driver/vehicle/trailer/carrier `WHERE is_current`) — per data-model §1
- [X] T009 Add `export * from "./trip-assignments"` to `packages/db/schema/index.ts` (depends on T008)
- [X] T010 Generate + apply Drizzle migration `packages/db/migrations/0005_*.sql` via `pnpm --filter @brazil-tms/db db:generate` then `db:migrate` (CREATE TABLE + FK constraints incl. the self-FK via `ALTER TABLE … ADD CONSTRAINT` + the partial-unique + 4 conflict indexes + trip history index; **no** `CREATE TYPE`, **no** `REVOKE`, **no** `ALTER TABLE trips`); verify `meta/_journal.json` updated (depends on T009)
- [X] T011 Create `packages/db/src/trips/trip-assignments.ts` with `gatherEligibilityContext(txOrDb, tripId, candidate): EligibilityContext` (loads the trip window/`planned_vehicle_type`, the candidate resources with status/type/expiry/ownership, and overlapping CURRENT assignments joined to active trips) + exported stubs for `assignTrip` / `unassignTrip` / `confirmTripAssignment` / `checkAssignment` (bodies filled in story phases) — mirror `trip-transitions.ts`/`trip-cancellation.ts` (depends on T007, T009)
- [X] T012 Extend `packages/db/src/trips/trips-read.ts`: board (LEFT JOIN current `trip_assignments` + driver/vehicle/carrier names; add `isAssigned`/`assignedDriverName`/`assignedVehiclePlate`/`assignedCarrierName` to `TripBoardRow`; add `assigned`/`driverId`/`vehicleId`/`carrierId` filters, shared with `exportTripRows`); detail (`currentAssignment` + `assignmentHistory` on `TripDetailView`); dashboard (fill `unassignedTrips` = count of active trips with no current assignment, replacing `null`); AND extend `getTripFilterOptions` to also return active `{ drivers, vehicles, trailers, carriers }` (id+label) — the picker/filter data source (resolves the resource-options gap so `assign_resources` roles that lack `manage_fleet_data` still get usable lists, loaded server-side) (depends on T009)
- [X] T013 Add exports to `packages/db/src/index.ts` for `assignTrip`/`unassignTrip`/`confirmTripAssignment`/`checkAssignment`/`gatherEligibilityContext` and the new read-model types (`currentAssignment`/`assignmentHistory`/extended `TripFilterOptions`) (depends on T011, T012)

### Web foundation (`apps/web`)

- [X] T014 [P] Create `apps/web/lib/trips/trip-assignments.ts` as a `"server-only"` re-export of `{ assignTrip, unassignTrip, confirmTripAssignment, checkAssignment }` from `@brazil-tms/db` (mirror `apps/web/lib/trips/trip-transitions.ts`) (depends on T013)
- [X] T015 [P] Update `apps/web/lib/trips/trips-read.ts` (server-only) to re-export the extended read models + new types (`currentAssignment`/`assignmentHistory`, extended `getTripFilterOptions` with fleet options) from `@brazil-tms/db` (depends on T013)
- [X] T016 [P] Extend `apps/web/app/api/trips/route.ts` (GET board, stays `view_all_trips`): parse + forward the new `assigned`/`driverId`/`vehicleId`/`carrierId` filter params and return the assignment row fields (depends on T015)
- [X] T017 [P] Extend `apps/web/app/api/trips/[id]/route.ts` (GET detail, stays `view_all_trips`): return `currentAssignment` + `assignmentHistory` in the `TripDetailView` (depends on T015)
- [X] T018 [P] Extend `apps/web/app/api/dashboard/summary/route.ts` (GET, stays `view_all_trips`): return the filled `unassignedTrips` count (depends on T015)
- [X] T019 [P] Extend `apps/web/messages/pt-BR.json`: a `Dispatch` namespace (board/panel/warning labels), assignment filter/view labels under `Trips.board` (incl. `viewUnassigned`, `filterAssigned/Driver/Vehicle/Carrier`), and the four audit actions BOTH nested under `Trips.auditActions.trip` (`assign`/`reassign`/`unassign`/`confirm`) AND flat under `AuditActions` (`trip_assign`/`trip_reassign`/`trip_unassign`/`trip_confirm`) — no dotted keys (depends on T002)
- [X] T020 [P] Add a `Dispatch` nav entry (`href: "/dispatch"`, permission `assign_resources`) to `NAV_ITEMS` in `apps/web/lib/nav.ts` (depends on T001)

### Foundational tests (Vitest unit — pure, no DB)

- [X] T021 [P] Unit test `packages/shared/src/domain/assignment-eligibility.test.ts`: `evaluateAssignmentEligibility` across every §19.2 check × severity, `DEFAULT_ASSIGNMENT_POLICY` values, `requiredResourcesFor(owned/subcontracted)`, `ASSIGNMENT_TURNAROUND_BUFFER_MINUTES` default (depends on T004)
- [X] T022 [P] Unit test `packages/shared/src/schemas/trip-assignment.test.ts`: `assignTripSchema`/`confirmAssignmentSchema`/`checkAssignmentSchema` (required fields, nullable-optional trailer/carrier, `expectedFromStatus` enum, length caps) (depends on T005)
- [X] T023 [P] Extend `packages/shared/src/schemas/trip-board.test.ts`: the new `assigned`/`driverId`/`vehicleId`/`carrierId` params round-trip from `URLSearchParams` via `PARAM_KEYS` (depends on T006)
- [X] T024 [P] Extend `packages/shared/src/audit/actions.test.ts`: `ALL_AUDIT_ACTIONS` contains the four new `trip.*` actions (depends on T002)
- [X] T025 [P] Extend `packages/shared/src/domain/trip-status.test.ts`: `canTransition` allows `validated→assigned`, `assigned→confirmed`, `assigned→validated` (depends on T003)
- [X] T026 [P] Extend `packages/shared/src/auth/permissions.test.ts`: `ROLE_PERMISSIONS`/`can` grants `assign_resources` to Admin/Operations Manager/Dispatcher/Fleet Coordinator and denies it to Control Tower/Finance/Executive Viewer (permission-matrix.md test focus)

**Checkpoint**: Schema applied, shared domain + Zod + audit actions exported, services scaffolded, read models + read routes expose assignment data, i18n + nav in place, foundational unit tests green. User stories can now begin.

---

## Phase 3: User Story 1 - Assign and confirm the resources that will run a trip (Priority: P1) 🎯 MVP

**Goal**: A dispatcher assigns driver/vehicle/trailer/carrier to a `validated` trip (server enforces the minimum-required set and refuses BLOCK conflicts; WARN requires an override reason) and confirms it (re-checking for BLOCK drift) — capturing notes + assigned/confirmed by/at and auditing each action.

**Independent Test**: On a `validated` trip's detail page, assign driver+vehicle (+carrier if subcontracted) → status `assigned`, one current assignment with by/at + notes; Confirm → status `confirmed` with a confirmation timestamp; `trip.assign`/`trip.confirm` appear in audit history; assigning with only a driver → `409 INCOMPLETE_ASSIGNMENT`.

- [X] T027 [US1] Implement `assignTrip` in `packages/db/src/trips/trip-assignments.ts` mirroring `transitionTripStatus`: enforce the minimum-required set (`requiredResourcesFor` → `Conflict("INCOMPLETE_ASSIGNMENT")`); `gatherEligibilityContext` + `evaluateAssignmentEligibility` → any BLOCK ⇒ `Conflict("ASSIGNMENT_BLOCKED", findings)`, any WARN without `overrideReason` ⇒ `Conflict("OVERRIDE_REQUIRED", findings)`, WARN + reason proceeds (persist `override_reason`); in one `db.transaction`: guarded `UPDATE trips … WHERE current_status='validated'` (0 rows ⇒ `STALE_TRANSITION`), INSERT the `is_current` assignment row, INSERT a `trip_events` `status_change` row, `writeAudit("trip.assign", … reason)`, return `loadTripDetail(tx, tripId)` (depends on T011, T013)
- [X] T028 [US1] Implement `confirmTripAssignment` in `packages/db/src/trips/trip-assignments.ts`: re-run the evaluator (drift) → unresolved BLOCK ⇒ `Conflict("ASSIGNMENT_BLOCKED", findings)`; else in one tx UPDATE the current assignment row (`confirmed_by/at`), guarded `UPDATE trips … WHERE current_status='assigned'` → `confirmed` (0 rows ⇒ `STALE_TRANSITION`), INSERT a `status_change` `trip_events` row, `writeAudit("trip.confirm")`, return `loadTripDetail` (depends on T027)
- [X] T029 [P] [US1] Create the POST handler in `apps/web/app/api/trips/[id]/assignment/route.ts` (assign): `requireAuth` → `requirePermission(ctx,"assign_resources")` → `assignTripSchema.parse(body)` → `assignTrip(id, input, ctx.userId)` → `NextResponse.json({ item })`; `try/catch handleRouteError`; `export const dynamic="force-dynamic"`; export only the POST handler (depends on T014)
- [X] T030 [P] [US1] Create the POST handler in `apps/web/app/api/trips/[id]/assignment/confirm/route.ts` (confirm): same auth/validate/respond shape calling `confirmTripAssignment` with `confirmAssignmentSchema` (depends on T014)
- [X] T031 [US1] Extend `apps/web/lib/trips/client.ts` with `useAssignTrip(id)` + `useConfirmAssignment(id)` mutation hooks (POST the two routes via `asJson`; `onSuccess` invalidate the `["trips"]` root; map error codes via `TripsError`) — follow `useUpdateTripPlan` (depends on T029, T030)
- [X] T032 [US1] Extend the `apps/web/app/(shell)/trips/[id]/page.tsx` server loader to call `getTripFilterOptions` and pass `resourceOptions` (active driver/vehicle/trailer/carrier lists) to `TripDetailClient` (depends on T015, T017)
- [X] T033 [US1] Create `apps/web/components/trips/trip-detail/assignment-panel.tsx`: client panel showing the current assignment (resource names, notes, assigned/confirmed by/at, override reason) + driver/vehicle/trailer/carrier pickers from `resourceOptions`, with Assign + Confirm wired to `useAssignTrip`/`useConfirmAssignment` and pt-BR labels/error mapping (depends on T031, T032, T019)
- [X] T034 [US1] Extend `apps/web/components/trips/trip-detail/trip-detail-client.tsx` to render `<AssignmentPanel … />` in place of `<AssignmentPlaceholder />` (depends on T033)
- [X] T035 [US1] Extend `apps/web/components/trips/trip-detail/placeholders.tsx` to remove the `AssignmentPlaceholder` export + its `sectionAssignment`/`placeholderAssignment` key union members (leave Exceptions/Documents/Billing placeholders untouched) (depends on T034)
- [X] T036 [P] [US1] Integration test `apps/web/lib/trips/trip-assignments.test.ts` (Vitest, static imports, `describe.skipIf(!DATABASE_URL)`, own seed + FK-safe cleanup): `assignTrip` happy path → `assigned` + one `is_current` row + `trip.assign` audit; `INCOMPLETE_ASSIGNMENT`; `STALE_TRANSITION` race; `confirmTripAssignment` → `confirmed` + `confirmed_by/at` + re-check + `trip.confirm` audit (depends on T027, T028, T010, T013)
- [X] T037 [P] [US1] Integration test asserting the DB partial-unique index `trip_assignments_trip_active_uq` (a second `is_current=true` insert for the same trip raises SQLSTATE 23505) in `apps/web/lib/trips/trip-assignments.test.ts` (the single-current-assignment integrity guard, FR-005/SC-005) (depends on T010)
- [X] T038 [P] [US1] Playwright e2e `apps/web/e2e/dispatch-assignment.spec.ts` (`apiLogin` as Ops Manager/Dispatcher): assign driver+vehicle+carrier → `assigned`, Confirm → `confirmed` with timestamp, and `trip.assign`/`trip.confirm` appear in the trip audit history (depends on T033, T034, T029, T030)

**Checkpoint**: US1 fully functional and independently testable — the MVP walking skeleton.

---

## Phase 4: User Story 2 - See conflict and eligibility warnings before committing (Priority: P1)

**Goal**: Inline, server-authoritative warnings (schedule overlap, resource status, vehicle-type, carrier eligibility, documentation) appear as the dispatcher picks resources; BLOCK prevents saving and cannot be bypassed by the client.

**Independent Test**: Construct each §19.2 conflict → the matching finding shows with correct severity in the panel; a BLOCK prevents save; a direct API call with a BLOCK combination is still refused (UI does not own authority).

- [X] T039 [US2] Implement read-only `checkAssignment(tripId, candidate): Finding[]` in `packages/db/src/trips/trip-assignments.ts` (`gatherEligibilityContext` + `evaluateAssignmentEligibility`, **no write**) (depends on T011, T004)
- [X] T040 [US2] Create the POST dry-run handler in `apps/web/app/api/trips/[id]/assignment/check/route.ts`: `requirePermission(ctx,"assign_resources")` + `checkAssignmentSchema.parse` → `{ findings }` (depends on T014, T039)
- [X] T041 [US2] Add `useAssignmentCheck(id)` mutation hook (POST `…/assignment/check`, returns `Finding[]`) to `apps/web/lib/trips/client.ts` (depends on T040)
- [X] T042 [US2] Add inline findings display (block/warn severity badges, pt-BR) to `apps/web/components/trips/trip-detail/assignment-panel.tsx`, refreshed via `useAssignmentCheck` as resources are picked (depends on T033, T041, T019)
- [X] T043 [P] [US2] Integration test `apps/web/lib/trips/assignment-check.test.ts`: `gatherEligibilityContext` overlap query (current assignments intersecting the trip window, excluding cancelled/terminal) + each §19.2 check surfaced with correct severity via `checkAssignment` (depends on T039, T010)
- [X] T044 [P] [US2] Playwright e2e `apps/web/e2e/dispatch-warnings.spec.ts`: each warning type surfaces inline; a BLOCK finding prevents save; a direct-API assign with a BLOCK combination is still refused (server-authoritative) (depends on T040, T042, T029)

**Checkpoint**: US1 + US2 together = a safe-to-ship dispatch (assign/confirm with authoritative warnings) — recommended MVP.

---

## Phase 5: User Story 3 - Override a warning with a recorded reason (Priority: P2)

**Goal**: A permitted user proceeds past a WARN by entering a required reason (persisted + audited); empty reason is refused; no one can override a BLOCK.

**Independent Test**: Trigger a WARN, save without reason → refused (`OVERRIDE_REQUIRED`); enter a reason → completes, reason in audit history; a user without `assign_resources` → `403`; a BLOCK → not overridable. (The service-side override logic lands in T027; this story delivers the UX + accountability tests.)

- [X] T045 [US3] Add the required, non-empty override-reason prompt (shown when WARN findings are present; rejects empty/whitespace) to `apps/web/components/trips/trip-detail/assignment-panel.tsx` (depends on T042)
- [X] T046 [P] [US3] Integration test `apps/web/lib/trips/assignment-override.test.ts`: `OVERRIDE_REQUIRED` (WARN, no reason, returns findings); `ASSIGNMENT_BLOCKED` (BLOCK not overridable); override succeeds with `override_reason` persisted + `trip.assign` audit `reason` recorded (depends on T027, T010)
- [X] T047 [P] [US3] Playwright e2e `apps/web/e2e/dispatch-override.spec.ts`: override-with-reason success, empty-reason refusal, non-permitted role `403`, BLOCK not overridable (depends on T045, T029)

**Checkpoint**: Override is accountable and permission-gated.

---

## Phase 6: User Story 4 - Reassign / substitute resources, retaining history (Priority: P2)

**Goal**: Substitute resources (new becomes the single current assignment; prior is superseded + retained; status unchanged; eligibility re-runs) and un-assign (back to `validated`, prior retained).

**Independent Test**: Reassign → exactly one current assignment (new), prior retained as superseded history, trip status unchanged, no new `status_change` event; un-assign → `validated`, prior retained.

- [X] T048 [US4] Implement `reassignTrip` in `packages/db/src/trips/trip-assignments.ts`: in one tx re-gather + re-evaluate (BLOCK ⇒ `ASSIGNMENT_BLOCKED`, WARN && !overrideReason ⇒ `OVERRIDE_REQUIRED`), supersede the current row (`is_current=false`, `superseded_by_assignment_id=new`, `superseded_at`), INSERT the new `is_current` row, **NO** `trip_events` status change, `writeAudit("trip.reassign", … reason)`, return `loadTripDetail` (depends on T027, T011)
- [X] T049 [US4] Implement `unassignTrip` in `packages/db/src/trips/trip-assignments.ts`: pre-tx `canTransition(assigned→validated)`; in one tx supersede the current row (retained, never deleted), guarded `UPDATE trips … WHERE current_status='assigned'` → `validated` (0 rows ⇒ `STALE_TRANSITION`; illegal ⇒ `ILLEGAL_TRANSITION`; missing ⇒ `NOT_FOUND`), INSERT a `status_change` `trip_events` row, `writeAudit("trip.unassign")`, return `loadTripDetail` (depends on T027, T011)
- [X] T050 [US4] Extend the POST handler in `apps/web/app/api/trips/[id]/assignment/route.ts` to route to `reassignTrip` when a current assignment already exists (trip `assigned`/`confirmed`) instead of `assignTrip`, keeping the auth/validate/respond shape, returning `{ item, findings }` (depends on T029, T048)
- [X] T051 [US4] Add a DELETE handler to `apps/web/app/api/trips/[id]/assignment/route.ts` (unassign): `requirePermission(ctx,"assign_resources")` → parse `{ expectedFromStatus:"assigned", notes? }` → `unassignTrip` → `{ item }`; export only HTTP handlers + `dynamic` (depends on T050, T049)
- [X] T052 [US4] Add `useReassignTrip(id)` + `useUnassignTrip(id)` hooks to `apps/web/lib/trips/client.ts` (POST `…/assignment` reassign; DELETE `…/assignment`; invalidate `["trips"]`) (depends on T050, T051)
- [X] T053 [US4] Extend `apps/web/components/trips/trip-detail/assignment-panel.tsx` to render the assignment-history chain (`currentAssignment` + `assignmentHistory` newest-first, with superseded-by/at + assigned-by/at) and add Reassign (reuses the assign form via `useReassignTrip`) + Unassign (`useUnassignTrip`, confirm dialog) actions (depends on T052, T017)
- [X] T054 [P] [US4] Integration test `apps/web/lib/trips/trip-reassign.test.ts`: reassign → exactly one `is_current` row (new resources), prior row retained (`is_current=false` + `superseded_by_assignment_id` + `superseded_at`, never deleted), trip `current_status` UNCHANGED, NO new `status_change` event, one `trip.reassign` audit, eligibility re-runs (BLOCK ⇒ `ASSIGNMENT_BLOCKED`; WARN no reason ⇒ `OVERRIDE_REQUIRED`) (depends on T048, T010)
- [X] T055 [P] [US4] Integration test `apps/web/lib/trips/trip-unassign.test.ts`: un-assign `assigned` trip → `validated`, current row superseded+retained (never deleted), one `status_change` event, one `trip.unassign` audit; stale/illegal/missing → `STALE_TRANSITION`/`ILLEGAL_TRANSITION`/`NOT_FOUND` (depends on T049, T010)
- [X] T056 [P] [US4] Playwright e2e `apps/web/e2e/dispatch-reassign.spec.ts`: assign → reassign a different resource via the panel → exactly one current assignment (new) + prior in the history chain; then unassign → `validated` with prior retained (depends on T053, T050, T051)

**Checkpoint**: Substitution + un-assign work with full retained history.

---

## Phase 7: User Story 5 - Work the Dispatch Board and surface assignment across the operating board (Priority: P2)

**Goal**: A dedicated Dispatch Board (unassigned-by-pickup + availability + warnings + assign/confirm), plus the assignment filters / "Unassigned" view / row indicator / quick-assign in the Control Tower and the dashboard "unassigned trips" count — filling slice 005's reserved shell.

**Independent Test**: `/dispatch` lists unassigned trips by pickup and assigns/confirms from the board; in `/trips` the assignment filters narrow the list, the "Unassigned" view scopes it, the row indicator reflects state, and a row quick-assign opens the form; `/` shows the live unassigned count deep-linking to the Unassigned view.

- [X] T057 [P] [US5] Append the `"unassigned"` preset to `DEFAULT_TRIP_VIEWS` in `apps/web/lib/trips/views.ts` (`params` → `assigned:"false", scope:"active", sort:"pickup"`; `labelKey:"viewUnassigned"`) — the slot 005 reserved (depends on T006)
- [X] T058 [P] [US5] Extend the URL-state hook in `apps/web/lib/trips/client.ts` to surface the assignment filter keys (`assigned`/`driverId`/`vehicleId`/`carrierId` via `setFilters`, reset offset on change) (depends on T006)
- [X] T059 [US5] Extend the `apps/web/app/(shell)/trips/page.tsx` server loader to pass `resourceOptions` (extended `getTripFilterOptions`) to the filter UI (depends on T015, T012)
- [X] T060 [US5] Add the `assigned` (tri-state all/assigned/unassigned) + driver/vehicle/carrier filter controls to `apps/web/components/trips/trip-filters.tsx` (sourced from `resourceOptions`, wired through `setFilters`) (depends on T057, T058, T059, T016)
- [X] T061 [P] [US5] Add the assignment row indicator/column to `apps/web/components/trips/control-tower-table.tsx` (render `isAssigned` + `assignedDriverName`/`assignedVehiclePlate`/`assignedCarrierName` from `TripBoardRow`) (depends on T016)
- [X] T062 [US5] Create the shared `apps/web/components/trips/dispatch/assignment-form.tsx` (resource pickers + live findings + notes/override-reason + assign/reassign/unassign/confirm actions) used by both the Trip Detail panel and the Dispatch Board (depends on T031, T041, T052)
- [X] T063 [US5] Add a quick-assign row action to `apps/web/components/trips/control-tower-table.tsx` (opens the shared `AssignmentForm` for that trip — the third FR-022 entry point; gated `assign_resources`) (depends on T061, T062)
- [X] T064 [US5] Create `apps/web/components/trips/dispatch/dispatch-board.tsx`: unassigned-by-pickup queue via `useTripBoard` (`assigned=false&scope=active&sort=pickup`), resource availability, inline warnings, assign/confirm from the board using the shared `AssignmentForm`; 30s polling (`CONTROL_TOWER_POLL_MS`), no Realtime (depends on T062, T016, T058)
- [X] T065 [US5] Create `apps/web/app/(shell)/dispatch/page.tsx`: server guard (redirect non-`assign_resources` users), load `resourceOptions`, render the client `DispatchBoard` (depends on T064, T015)
- [X] T066 [P] [US5] Wire `apps/web/components/trips/dashboard/widgets.tsx` to render the `unassignedTrips` count + deep-link to the `"unassigned"` view (`?assigned=false…`) once the read model returns a number (depends on T018, T057)
- [X] T067 [P] [US5] Integration test `apps/web/lib/trips/trips-read.test.ts`: board `assigned=true/false` filter (LEFT JOIN + `isAssigned`/`assignedDriverName`), dashboard `unassignedTrips` count, and extended `getTripFilterOptions` returns active fleet (depends on T012, T010)
- [X] T068 [P] [US5] Extend `apps/web/lib/trips/views.test.ts`: the `"unassigned"` preset sets `assigned=false`/`scope=active`/`sort=pickup` and clears mutually-exclusive keys (depends on T057)
- [X] T069 [US5] Playwright e2e `apps/web/e2e/dispatch-board.spec.ts`: Dispatch Board lists unassigned-by-pickup + assign/confirm from the board; Control Tower assignment filters + "Unassigned" view narrow the list + row indicator reflects state + quick-assign opens the form; Home Dashboard unassigned count shows the live number + deep-links to the Unassigned view (depends on T064, T060, T061, T063, T066)

**Checkpoint**: All five user stories independently functional; the operating board is fully assignment-aware.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T070 [P] Add the no-dotted-key + audit-action completeness assertions for the four new actions to `apps/web/lib/messages.test.ts` (every `ALL_AUDIT_ACTIONS` entry has a flat `AuditActions` key via `action.replaceAll(".","_")`; the nested `Trips.auditActions.trip` entries resolve; no key contains `.`) (depends on T019, T002)
- [X] T071 Run `pnpm exec vitest run --project web apps/web/lib/messages.test.ts` and fix any missing/dotted-key failures in `apps/web/messages/pt-BR.json` (depends on T070)
- [X] T072 [P] Authz matrix e2e `apps/web/e2e/dispatch-authz.spec.ts` (`apiLogin`): `assign_resources` holder → `200` on assign; non-holder (Finance/Control Tower) → `403` on assign/reassign/unassign/confirm/check with a valid body; view-only role still reads assignment data via `view_all_trips` (`GET /api/trips`, `/api/trips/:id`, `/api/dashboard/summary` → `200`) (depends on T029, T030, T040, T050, T051)
- [X] T073 [P] Add a performance-sanity note to `specs/006-dispatch-assignment/quickstart.md`: observe assignment + full check `< 2s` (SC-003) and Dispatch Board load `< 3s` (SC-006) at medium scale via the indexed current-assignment lookups (manual timing, not a perf harness) (depends on T064, T040)
- [X] T074 Run the quickstart.md US1–US5 validation against a fresh build (`pnpm db:seed:e2e` first to reset accounts) (depends on T069, T038, T044, T047, T056)
- [X] T075 Run the quality gates from repo root and fix failures: `pnpm lint`; `pnpm typecheck`; `pnpm build`; `pnpm test` (with `DATABASE_URL` set) — targeting the `dev` branch (depends on T071, T074)
- [X] T076 Open the 006 PR to `dev` via `gh pr create --base dev` using the PR template, noting: first enforcement of `assign_resources`; one new table `trip_assignments` (no new enum/permission key/package/worker); and the out-of-scope/config defaults (carrier approved-for rule, per-customer severity overrides, broader owned-vs-subcontracted policy, vehicle-type substitution, turnaround buffer) — AI does NOT merge to `main` (depends on T075)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (T001)**: none.
- **Foundational (T002–T026)**: depends on Setup — BLOCKS all user stories. Internal order: shared schema/domain (T002–T007) and the DB table/migration (T008–T010) before the service scaffold + read models (T011–T013); web re-exports + read-route extends + i18n/nav (T014–T020) after their DB/shared deps; foundational unit tests (T021–T026) after the code they cover.
- **US1 (T027–T038, P1)**: after Foundational. The MVP.
- **US2 (T039–T044, P1)**: after Foundational; T039 (checkAssignment) needs `gatherEligibilityContext` (T011) + evaluator (T004); T042 extends the US1 panel (T033).
- **US3 (T045–T047, P2)**: after US1 (override logic is in `assignTrip` T027) + US2 (findings UI T042).
- **US4 (T048–T056, P2)**: after US1 (services build on `assignTrip`/`gatherEligibilityContext`; routes extend the US1 route file).
- **US5 (T057–T069, P2)**: after Foundational (board/detail/dashboard read-routes + filter options) and after US1/US2/US4 hooks (the shared `AssignmentForm` T062 composes them).
- **Polish (T070–T076)**: after the stories it validates.

### Story Independence

- US1 is independently shippable (the walking skeleton). US2 hardens it (warnings) and is the recommended MVP boundary (both P1). US3/US4/US5 each add value without breaking earlier stories. US3 depends on US2's findings UI; US4 and US5 build on US1's service/route/hooks but remain independently testable.

### Parallel Opportunities

- **Foundational**: T002–T006 (different shared files) run in parallel; T008 then T009→T010 (schema→migration) serialize; T014–T020 parallelize once their deps land; T021–T026 (unit tests) all parallel.
- **US1**: T029 ∥ T030 (different route files); T036 ∥ T037 ∥ T038 (different test files) once their impl deps are met.
- Service-file tasks that touch `packages/db/src/trips/trip-assignments.ts` (T027, T028, T039, T048, T049) are **sequential** (same file). Panel tasks (T033, T042, T045, T053) are **sequential** (same file). Route tasks T050/T051 are sequential (same file).
- Different user stories can be staffed in parallel once Foundational completes (mind the shared-file serializations above).

---

## Parallel Example: User Story 1

```bash
# Routes (different files) together:
Task: "POST assign handler in apps/web/app/api/trips/[id]/assignment/route.ts"        # T029
Task: "POST confirm handler in apps/web/app/api/trips/[id]/assignment/confirm/route.ts" # T030

# US1 tests (different files) together, after their implementations land:
Task: "Integration test apps/web/lib/trips/trip-assignments.test.ts"   # T036
Task: "Partial-unique-index enforcement test (same file, append)"      # T037
Task: "Playwright e2e apps/web/e2e/dispatch-assignment.spec.ts"        # T038
```

---

## Implementation Strategy

### MVP First

1. Complete Phase 1 (Setup) + Phase 2 (Foundational).
2. Complete Phase 3 (US1) → **STOP and VALIDATE**: assign + confirm works end-to-end with audit. Walking-skeleton MVP.
3. Complete Phase 4 (US2, also P1) → safe-to-ship dispatch (assign/confirm with server-authoritative warnings). **Recommended MVP boundary.**

### Incremental Delivery

US3 (override accountability) → US4 (reassign/unassign/history) → US5 (Dispatch Board + Control Tower/dashboard integration) → Polish (i18n/authz/perf/quickstart/quality-gates/PR). Each story is demoable and independently testable.

---

## Notes

- Tests are included (required by plan/Constitution §3.13/quickstart). Service correctness → Vitest (`packages/shared` unit, `apps/web/lib` integration with `DATABASE_URL`); HTTP-status + finding payloads + UI flows + the authz matrix → Playwright `e2e/` (the project has **no** `route.test.ts`).
- `[P]` = different files, no incomplete dependency. The five service-body tasks share `trip-assignments.ts` and the four panel tasks share `assignment-panel.tsx` — kept sequential.
- No new permission key (reuse `assign_resources`, first enforced), no new enum, one new table; conflict authority is server-side; superseded assignments are retained (never hard-deleted); freshness is polling (no Realtime); UI is pt-BR with no dotted i18n keys.
- Commit after each task or logical group; AI does not merge to `main` (PRs target `dev`).
