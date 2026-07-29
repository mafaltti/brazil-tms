---
description: "Task list for feature 005 — Control Tower, Trip List, Trip Detail, and Daily Dashboard"
---

# Tasks: Control Tower, Trip List, Trip Detail, and Daily Dashboard

**Feature**: 005-control-tower | **Plan**: [plan.md](./plan.md) · **Spec**: [spec.md](./spec.md) · **Data model**: [data-model.md](./data-model.md) · **Contracts**: [contracts/](./contracts/)

**Tests**: Vitest is the primary quality gate (Constitution + STACK §3.13). Test tasks ARE included and REQUIRED — board read-model filter/sort/paginate + total, detail enrichment, dashboard metrics (+ later-slice `null`), export bounding, the plan-edit before-completion/review/permission guards, and `view_all_trips` enforcement. Critical UI flows covered by Playwright.

**Organization**: Tasks grouped by user story (US1–US5 from spec.md); each is an independently testable increment. Read-first slice — **no new table/enum/package/worker/permission key** (reuse `view_all_trips`, first-enforced here; the one write reuses 003's `updateTripPlan`).

**Total tasks**: 65 · **Parallelizable**: 40 ([P]) · **MVP**: Phase 1 + Phase 2 + Phase 3 (US1) + Phase 4 (US2) = view/filter the board **and** inspect a trip (PRD §23 "Operations can view and filter all trips")

## Format: `[ID] [P?] [Story?] Description`

- **[P]** = parallelizable (different files, no dependency on another incomplete task in the same phase)
- **[US#]** = the user story it serves; Setup/Foundational/Polish carry no story tag
- File paths are repo-relative; every task names the exact file(s) it touches

## Phase 1: Setup (shared prerequisites)

- [X] T001 [P] Confirm `@brazil-tms/db` exports the 003 trip services (`listTrips`, `getTrip`, `updateTripPlan`, `billingStatus`, `loadTripDetail`/`TripDetail`) in `packages/db/src/index.ts` — anchor for new read-model re-exports (no change yet)
- [X] T002 [P] Confirm `view_all_trips` exists in `ROLE_PERMISSIONS` for all 7 internal roles in `packages/shared/src/auth/permissions.ts` (baseline for first-enforcement; **no code change** — do NOT add a `view_trips` key)
- [X] T003 [P] Create read-model file `packages/db/src/trips/trips-read.ts` (empty module) and its server-only re-export `apps/web/lib/trips/trips-read.ts` (`import "server-only"; export * from "@brazil-tms/db"` board/detail/dashboard/export fns added per story)
- [X] T004 [P] Create client query base `apps/web/lib/trips/client.ts` with poll-interval constants `CONTROL_TOWER_POLL_MS = 30_000`, `DASHBOARD_POLL_MS = 60_000`, `TRIP_DETAIL_POLL_MS = 30_000` and `EXPORT_ROW_CAP = 10_000`

## Phase 2: Foundational — domain helpers, Zod, index, i18n base, permission test (BLOCKS all user stories)

- [X] T005 [P] Unit test the new status helpers in `packages/shared/src/domain/trip-status.test.ts` — `ACTIVE_TRIP_STATUSES`/`isActiveStatus` (12 non-terminal), `billingStatusToStatuses` (billing-phase → self; else []), `NON_EDITABLE_TRIP_STATUSES` (completed/billing_*/billed/cancelled/disputed)
- [X] T006 Implement `ACTIVE_TRIP_STATUSES`, `isActiveStatus`, `billingStatusToStatuses`, `NON_EDITABLE_TRIP_STATUSES` in `packages/shared/src/domain/trip-status.ts` (reuse existing `TRIP_STATUSES`/`billingStatus`; export from `packages/shared/src/index.ts`)
- [X] T007 [P] Unit test the board Zod schemas in `packages/shared/src/schemas/trip-board.test.ts` — `tripBoardQuerySchema` (filter/sort whitelist/pagination 1–200/scope default `active`), `tripExportQuerySchema` (no limit/offset), `updateTripPlanSchema` (≥1 field, window start ≤ end)
- [X] T008 Implement `tripBoardQuerySchema`, `tripExportQuerySchema`, `updateTripPlanSchema` in `packages/shared/src/schemas/trip-board.ts` (export from `packages/shared/src/index.ts`) *(data-model §Validation rules; R3/R8/R11/R13)*
- [X] T009 [P] Add + unit-test `dayRangeSaoPaulo(date)` (BRT day → UTC `{from,to}`) in `packages/shared/src/formatting.ts` + `formatting.test.ts` *(R6, FR-032)*
- [X] T010 Add index `trips_pickup_start_idx` on `planned_pickup_window_start` in `packages/db/schema/trips.ts` *(data-model §New index; R5)*
- [X] T011 Generate + apply the migration: `pnpm --filter @brazil-tms/db db:generate` then `db:migrate` (single index; no `REVOKE` hand-append needed)
- [X] T012 [P] Extend `packages/shared/src/auth/permissions.test.ts` with `view_all_trips` invariants — `can(role,'view_all_trips')===true` for all 7 internal roles; `can('dispatcher','manage_trips')===false`, `can('finance','manage_trips')===false` *(contracts/permission-matrix.md)*
- [X] T013 [P] Add the `Trips` i18n namespace base in `apps/web/messages/pt-BR.json` — 18 trip-status labels + billing-status labels (shared by board/detail/dashboard)
- [X] T014 [P] Create `TripStatusBadge` (pt-BR label + accessible status colour, master-data badge pattern) in `apps/web/components/trips/trip-status-badge.tsx` *(R14, §16 contrast)*

## Phase 3: User Story 1 — See, search, and filter every trip (P1) 🎯 MVP

**Goal**: An authorized user opens the Control Tower and sees all permitted trips in a dense, sortable, paginated table defaulting to active/open trips; searches by external ID/customer/lane; filters by the 8 data-backed dimensions (AND); picks data-backed default views; shares via URL; the board polls.

**Independent test**: With seeded trips, open `/trips`; verify the active-default board; apply each filter + an AND combo + a default view; reload from the URL (filters persist); confirm a ~30s poll refresh and that no assigned-driver/vehicle/carrier or SLA-risk controls exist (006/007).

**Checkpoint**: US1 independently shippable — the operating board works end-to-end.

- [X] T015 [P] [US1] Integration test `queryTripBoard` in `apps/web/lib/trips/trips-read.test.ts` — each filter, AND combo, billing-status→status mapping, sort whitelist, `limit`/`offset` + correct `total`, active-default scope (dev DB, `skipIf(!DATABASE_URL)`)
- [X] T016 [US1] Implement `queryTripBoard(filters, sort, page) → { rows, total }` in `packages/db/src/trips/trips-read.ts` (joins customers/origin+dest locations/lanes for names; composed AND filters; whitelist sort; pagination; parallel `count`) and re-export via `apps/web/lib/trips/trips-read.ts` *(R2/R3/R4; contracts GET /api/trips)*
- [X] T017 [P] [US1] Route test `GET /api/trips` in `apps/web/app/api/trips/route.test.ts` — `view_all_trips` → 200 `{items,total,limit,offset}`; no session → 401; role lacking key → 403; bad param → 400; filter/sort/paginate honored
- [X] T018 [US1] Extend `GET /api/trips` handler in `apps/web/app/api/trips/route.ts` — **re-gate `manage_trips` → `view_all_trips`**, parse `tripBoardQuerySchema`, call `queryTripBoard`, return `{ items, total, limit, offset }` *(R1; contracts)*
- [X] T019 [P] [US1] Client hook `useTripBoard` + URL filter-state (parse/serialize via `tripBoardQuerySchema` with `useSearchParams`/`router.replace`) + `CONTROL_TOWER_POLL_MS` in `apps/web/lib/trips/client.ts` *(R7/R8, FR-005/FR-008)*
- [X] T020 [P] [US1] Default-views config (Today, Next 24h, In transit, Billing pending) + extensible view-registry shape in `apps/web/lib/trips/views.ts` *(R9, FR-006/FR-006a)*
- [X] T021 [US1] Dense, sortable, paginated Control Tower table (TanStack Table; status/billing indicators via `TripStatusBadge`; row → detail link) in `apps/web/components/trips/control-tower-table.tsx` *(FR-001/FR-007, §16)*
- [X] T022 [US1] Filters + persistent search UI — the 8 data-backed filters (customer, date range, status, origin, destination, lane, vehicle type, billing status) with AND semantics; **no** later-slice controls — in `apps/web/components/trips/trip-filters.tsx` *(FR-002/FR-003a/FR-003b/FR-004)*
- [X] T023 [US1] Control Tower page (server guard `requirePermission view_all_trips` → client board) in `apps/web/app/(shell)/trips/page.tsx`
- [X] T024 [P] [US1] Add the "Control Tower / Trips" nav item gated on `view_all_trips` in `apps/web/lib/nav.ts` (and surface in `apps/web/components/shell/app-sidebar.tsx`)
- [X] T025 [P] [US1] pt-BR strings for board column headers, filter labels, default-view names, empty-state in `apps/web/messages/pt-BR.json`
- [X] T026 [P] [US1] Playwright `apps/web/e2e/trips-control-tower.spec.ts` — view → search → filter AND combo → default view → URL reload persists → poll refresh; plus read-access authz for Dispatcher/Control Tower/Finance/Executive and 401 unauthenticated

## Phase 4: User Story 2 — Inspect one trip end-to-end (P1)

**Goal**: From the board or a direct link, open a Trip Detail page showing the header, customer plan (immutable original + live + actual milestone timestamps), timeline (read-only), notes, audit history, and labelled placeholder sections for assignment/exceptions/documents/billing.

**Independent test**: Click a trip; verify all §15.5 sections render (populated or labelled placeholder), audit history is read-only, and it loads within ~2s; a missing/not-permitted id returns a clear not-found.

**Checkpoint**: US1 + US2 = the MVP operating loop (view + inspect).

- [X] T027 [P] [US2] Integration test `getTripDetailView` in `apps/web/lib/trips/trips-read.test.ts` — name enrichment (customer/origin/destination/lane), `importBatchId`, events + audit present, `null` on missing id
- [X] T028 [US2] Implement `getTripDetailView(id)` in `packages/db/src/trips/trips-read.ts` (wrap 003 `loadTripDetail` + join display names + `import_batch_id`) and re-export via `apps/web/lib/trips/trips-read.ts` *(R10; contracts GET /api/trips/:id)*
- [X] T029 [P] [US2] Route test `GET /api/trips/:id` in `apps/web/app/api/trips/[id]/route.test.ts` — `view_all_trips` → 200 enriched `{item}`; 401/403; 404 on unknown id
- [X] T030 [US2] Extend `GET /api/trips/:id` handler in `apps/web/app/api/trips/[id]/route.ts` — **re-gate → `view_all_trips`**, return `getTripDetailView(id)` (404 when null) *(R1)*
- [X] T031 [P] [US2] Client hook `useTripDetail(id)` (+ `TRIP_DETAIL_POLL_MS`) in `apps/web/lib/trips/client.ts`
- [X] T032 [US2] Detail header + customer-plan section (original plan vs live planned + actual milestone timestamps, clearly separated) in `apps/web/components/trips/trip-detail/header.tsx` + `customer-plan.tsx` *(FR-012/FR-013, §15.5)*
- [X] T033 [P] [US2] Timeline (read-only `trip_events`), Notes, and Audit-history (read-only, mapped `trip.*` actions) section components in `apps/web/components/trips/trip-detail/{timeline,notes,audit-history}.tsx` *(FR-015/FR-019/FR-020)*
- [X] T034 [P] [US2] Labelled placeholder section components (assignment → 006, exceptions → 007, documents → 008, billing detail → 008) in `apps/web/components/trips/trip-detail/placeholders.tsx` *(FR-014/FR-016/FR-017/FR-018)*
- [X] T035 [US2] Trip Detail page (server guard `view_all_trips` → client detail composing all sections) in `apps/web/app/(shell)/trips/[id]/page.tsx` *(FR-011, FR-021)*
- [X] T036 [P] [US2] pt-BR strings for detail section titles, placeholder "não disponível ainda" label, and `trip.*` audit-action labels in `apps/web/messages/pt-BR.json`
- [X] T037 [P] [US2] Playwright `apps/web/e2e/trip-detail.spec.ts` — open from board → header + all 10 §15.5 sections (incl. placeholders) → audit read-only → not-found path

## Phase 5: User Story 3 — Edit operational fields before completion (P2)

**Goal**: An authorized user (Admin/Ops Manager) edits live planned fields on a non-completed trip; the change saves via 003's `updateTripPlan`, is audited, and reflects on the board next poll; editing is blocked at/after completion and refused without permission.

**Independent test**: Edit a planned field on a `received`/`validated` trip → saved + audited + board updates within a poll; same on `completed` → blocked (`409 EDIT_NOT_ALLOWED`); past `confirmed` without review → `409 REVIEW_REQUIRED`; as Dispatcher → `403`.

**Checkpoint**: US3 adds controlled mutation without redefining 003's domain.

- [X] T038 [P] [US3] Route integration test `PATCH /api/trips/:id/plan` in `apps/web/app/api/trips/[id]/plan/route.test.ts` — happy save + `trip.plan_update` audit; the edit leaves `current_status` unchanged (no transition — FR-026); `completed`/terminal → 409 `EDIT_NOT_ALLOWED`; past-`confirmed` no review → 409 `REVIEW_REQUIRED`; concurrent → 409 `STALE_TRANSITION`; Dispatcher → 403; empty body → 400
- [X] T039 [US3] Implement `PATCH /api/trips/:id/plan` in `apps/web/app/api/trips/[id]/plan/route.ts` — `requirePermission(ctx,'manage_trips')`, parse `updateTripPlanSchema`, **before-completion guard** (reject when `current_status ∈ NON_EDITABLE_TRIP_STATUSES`), call `updateTripPlan(id, changes, { authorizedReview }, ctx.userId)` (re-exported by `apps/web/lib/trips/trip-plan.ts`), map 409 codes via `handleRouteError` *(R11; contracts PATCH …/plan)*
- [X] T040 [P] [US3] Client mutation hook `useUpdateTripPlan` (on success invalidate board + detail queries) in `apps/web/lib/trips/client.ts`
- [X] T041 [US3] Inline plan-edit form (the 10 live planned fields; hidden/disabled when `current_status` non-editable; optional review flag; surfaces conflict messages) in `apps/web/components/trips/plan-edit-form.tsx`, wired into the Trip Detail page *(FR-022/FR-025/FR-027)*
- [X] T042 [P] [US3] pt-BR strings for the edit form fields and conflict messages (`EDIT_NOT_ALLOWED`/`REVIEW_REQUIRED`/`STALE_TRANSITION`) in `apps/web/messages/pt-BR.json`
- [X] T043 [P] [US3] Extend Playwright `apps/web/e2e/trip-detail.spec.ts` — edit before completion saves + appears in audit; edit on `completed` blocked; Dispatcher refused

## Phase 6: User Story 4 — Answer "what needs attention today?" (P2)

**Goal**: The Home Dashboard shows the eight §15.2 widgets; trips-today-by-status and billing-pending are computed live; later-slice widgets render labelled placeholders; each populated widget deep-links into the filtered Control Tower.

**Independent test**: Open `/`; verify all 8 widgets; computed counts match seeded data; later-slice widgets show placeholders (no invented numbers); click a populated widget → board opens filtered; dashboard polls at 60s.

**Checkpoint**: US4 gives managers the daily triage view.

- [X] T044 [P] [US4] Integration test `queryDashboardMetrics` in `apps/web/lib/trips/trips-read.test.ts` — trips-today-by-status (BRT) + billing-pending count correct; `tripsAtRisk/unassignedTrips/activeExceptions/onTime*/completedMissingDocuments` all `null`
- [X] T045 [US4] Implement `queryDashboardMetrics()` in `packages/db/src/trips/trips-read.ts` (BRT today via `dayRangeSaoPaulo`; group `current_status`; billing-pending count; later-slice metrics `null`) and re-export *(R12; contracts GET /api/dashboard/summary)*
- [X] T046 [P] [US4] Route test `GET /api/dashboard/summary` in `apps/web/app/api/dashboard/summary/route.test.ts` — `view_all_trips` → 200 `{summary}` with computed values + `null`s; 401/403
- [X] T047 [US4] Implement `GET /api/dashboard/summary` handler in `apps/web/app/api/dashboard/summary/route.ts`
- [X] T048 [P] [US4] Client hook `useDashboardSummary` (+ `DASHBOARD_POLL_MS`) in `apps/web/lib/trips/client.ts`
- [X] T049 [US4] Dashboard widget components — 8 §15.2 widgets; `null` → labelled placeholder; each computed widget carries board filter params for one-click deep-link — in `apps/web/components/trips/dashboard/widgets.tsx` *(FR-028/FR-029/FR-030)*
- [X] T050 [US4] Wire the Home (daily) Dashboard into `apps/web/app/(shell)/page.tsx` (server guard `view_all_trips` → client widgets) *(REP-001, §15.2)*
- [X] T051 [P] [US4] pt-BR strings for the 8 widget titles + placeholder label in `apps/web/messages/pt-BR.json`
- [X] T052 [P] [US4] Playwright `apps/web/e2e/dashboard.spec.ts` — all widgets render; computed counts; placeholders for later-slice; deep-link opens filtered board

## Phase 7: User Story 5 — Export the filtered trip list (P3)

**Goal**: From a filtered board, export a CSV containing exactly the filtered, permitted rows; an over-cap result prompts narrowing (no silent truncation).

**Independent test**: Filter → Export → CSV downloads with exactly the on-screen rows + board columns (UTF-8 BOM renders pt-BR accents in Excel); change filters → contents change; over-cap (>10,000) → clear error, no file.

**Checkpoint**: US5 completes the read surface (REP-005).

- [X] T053 [P] [US5] Tests for export in `apps/web/lib/trips/trips-read.test.ts` (`exportTripRows` returns exactly the filtered rows; throws `EXPORT_TOO_LARGE` over cap) and route test `apps/web/app/api/trips/export/route.test.ts` (CSV body + BOM + columns + `Content-Disposition`; over-cap → 422; `view_all_trips`)
- [X] T054 [US5] Implement `exportTripRows(filters, cap = EXPORT_ROW_CAP)` in `packages/db/src/trips/trips-read.ts` (reuse `queryTripBoard` where/sort, no pagination; throw `Conflict('EXPORT_TOO_LARGE')` when count > cap) and re-export *(R13; contracts GET /api/trips/export)*
- [X] T055 [US5] Implement `GET /api/trips/export` in `apps/web/app/api/trips/export/route.ts` — `view_all_trips`, parse `tripExportQuerySchema`, build CSV string (UTF-8 BOM + board columns) → `200 text/csv` attachment; over-cap → `422 EXPORT_TOO_LARGE` *(FR-033)*
- [X] T056 [US5] Export button bound to the current board filters in `apps/web/components/trips/trip-filters.tsx` (triggers `/api/trips/export?<current params>`)
- [X] T057 [P] [US5] pt-BR strings for the export button + over-cap "refine filtros" message in `apps/web/messages/pt-BR.json`
- [X] T058 [P] [US5] Extend Playwright `apps/web/e2e/trips-control-tower.spec.ts` — export filtered set → CSV contents match; over-cap → prompt, no download

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T059 [P] Confirm `EXPORT_ROW_CAP` (10,000) is a single named constant referenced by both `exportTripRows` and the over-cap message (no magic number) in `apps/web/lib/trips/client.ts` / `packages/db/src/trips/trips-read.ts`
- [X] T060 [P] Accessibility pass: status-colour contrast on `TripStatusBadge` and keyboard table navigation on the Control Tower (§16) in `apps/web/components/trips/*`
- [X] T061 [P] Verify no Supabase Realtime is introduced — all freshness is TanStack Query polling (grep `realtime`/`channel` in `apps/web`); confirm per-surface intervals wired
- [X] T062 Run `pnpm lint && pnpm typecheck && pnpm build && pnpm test`, then `$env:DATABASE_URL=...; pnpm exec vitest run --project web`, and fix all failures
- [X] T063 Run e2e: `pnpm --filter @brazil-tms/db db:seed:e2e` then `pnpm --filter @brazil-tms/web test:e2e --workers=1`; fix failures
- [X] T064 Verify `quickstart.md` US1–US5 end-to-end against a clean DB (`db:seed:master-data` + `db:seed:trip-domain`)
- [X] T065 [P] Confirm the `CLAUDE.md` SPECKIT marker (already pointing at 005's plan) is accurate after implementation; update if file paths changed

## Dependencies & Execution Order

**Phase gates**:

- Phase 1 (Setup) → Phase 2 (Foundational) → Phase 3+ (user stories) → Phase 8 (Polish).
- **Phase 2 BLOCKS all user stories** — the status helpers, board Zod schemas, the pickup index/migration, the BRT util, the `view_all_trips` test, and the status badge/i18n base must exist first.
- Within a user story, the test task(s) precede the implementation they cover; the read-model impl precedes its endpoint, which precedes the screen.

**Story dependencies**:

- **US1 (P1)** — depends only on Foundational; the MVP board.
- **US2 (P1)** — depends on Foundational; reuses the board's row→detail link (US1) for navigation but is independently testable via direct URL.
- **US3 (P2)** — depends on US2 (the edit form lives on the Trip Detail page) and on 003's `updateTripPlan`.
- **US4 (P2)** — depends on Foundational (BRT util, status helpers); deep-links into US1's board but is independently testable.
- **US5 (P3)** — depends on US1 (`queryTripBoard` where/sort + the board filter state it exports).

**Shared-file note**: `apps/web/lib/trips/client.ts`, `packages/db/src/trips/trips-read.ts`, and `apps/web/messages/pt-BR.json` are touched by several stories — tasks that edit the same file are sequential (not `[P]` against each other) even across phases.

## Parallel Execution Examples

**Phase 2 (Foundational)** — launch together (distinct files):

```
T005 [P] packages/shared/src/domain/trip-status.test.ts
T007 [P] packages/shared/src/schemas/trip-board.test.ts
T009 [P] packages/shared/src/formatting.ts (+test)
T012 [P] packages/shared/src/auth/permissions.test.ts
T013 [P] apps/web/messages/pt-BR.json
T014 [P] apps/web/components/trips/trip-status-badge.tsx
# then T006 → T008 (impl, after their tests) ; T010 → T011 (schema → migration, sequential)
```

**Phase 3 (US1)** — tests + independent UI files in parallel:

```
T015 [P] trips-read.test.ts , T017 [P] route.test.ts          # tests first
then T016 → T018                                              # read model → endpoint (sequential)
T019 [P] client.ts , T020 [P] views.ts , T024 [P] nav.ts , T025 [P] pt-BR.json , T026 [P] e2e
then T021 → T022 → T023                                       # table → filters → page
```

**Across stories** — once Foundational is done, US1/US2/US4 read-model+endpoint tracks can proceed in parallel (different files); US3 waits on US2's page, US5 waits on US1's `queryTripBoard`.

## Implementation Strategy

**MVP first (US1 + US2)**:

1. Complete Phase 1 (Setup) + Phase 2 (Foundational).
2. Complete Phase 3 (US1) — the Control Tower board. **STOP and validate** (PRD §23 "Operations can view and filter all trips").
3. Complete Phase 4 (US2) — Trip Detail. Demo: filter the board, open a trip, see the full record. This is the shippable MVP.

**Incremental delivery**:

- Add US3 (edit before completion) → US4 (daily dashboard) → US5 (CSV export).
- Each story is a PR to `dev` with its Vitest + Playwright green; run the full quality gate (lint/typecheck/build/test) before each PR.

**Parallel team strategy**: after Foundational, split US1/US2/US4 across developers (mostly distinct files); coordinate the shared `client.ts` / `trips-read.ts` / `pt-BR.json` edits sequentially. US3 follows US2; US5 follows US1.

## Notes

- `[P]` = different files, no incomplete-task dependency; safe to parallelize.
- Reuse, don't redefine: reads consume 003/004; the only write calls 003's `updateTripPlan`; authorization first-enforces the existing `view_all_trips` (no new key) — **do not add a `view_trips` key**.
- Every task names its exact file(s); keep diffs minimal (Constitution I). Commit per task or per small `[P]` group; PR per user story to `dev`.
- Do not mark any §29-/upstream-blocked item complete (SLA thresholds → 007, assignment dims → 006, billing/doc detail → 008, "Limited" edit scope, saved-views-by-role, export-cap value): scaffold with labelled defaults only (Constitution II). No customer/SLA/document/billing values invented.
- AI does not merge to `main`.
