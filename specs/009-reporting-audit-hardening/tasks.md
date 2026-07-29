# Tasks: Reporting, Audit Views, Hardening, and MVP Acceptance

**Input**: Design documents from `/specs/009-reporting-audit-hardening/`
**Prerequisites**: plan.md (required), spec.md (user stories US1–US5), research.md (R0–R10), data-model.md (NO new tables — 3 report read models + `onTimeExpr` + extended audit read), contracts/ (bff-endpoints.md, permission-matrix.md, acceptance-and-hardening.md), quickstart.md
**Tests**: INCLUDED — explicitly required by the plan's Testing section and Constitution §3.13 (permission checks, billing-readiness rules) and, for this slice, the **hardening proofs are themselves the deliverables** (permission-coverage, audit-completeness, localization, performance).

**Organization**: Tasks are grouped by user story so each is independently implementable and testable. Setup → Foundational (blocking) → US1 (P1) → US2 (P2) → US3 (P2) → US4 (P3) → US5 (P1, the cross-cutting release gate — sequenced last because it validates the assembled MVP) → Polish.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1..US5 for story-phase tasks (Setup / Foundational / Polish have no story label)
- Exact repo-relative file paths are in each description

## Path Conventions

Existing monorepo (per plan.md Project Structure): `packages/shared/src/`, `packages/db/src/`, `apps/web/`. **Read-only slice**: NO new table, enum, migration, permission key, package, worker job, or runtime dependency (default build). The three report read models live in a new `packages/db/src/reporting/` dir — **one file per report** (`sla.ts`, `exceptions.ts`, `billing-readiness.ts`) to keep stories independently editable (a task-time refinement of the plan's single `trips/reporting.ts`); the shared on-time predicate is `packages/db/src/trips/on-time.ts`; the extended audit read is `packages/db/src/audit/audit-read.ts`. Reports gated by `view_all_trips`, audit view by `view_audit_log` (both reused). Reports are tables + summary cards (NO charting lib). Freshness is polling (60s); UI pt-BR; timestamps UTC (displayed `America/Sao_Paulo`); money integer centavos (BRL). Per **clarify Q1**, §29-gated criteria are **pass-with-blocked-sign-off** (provisional banner + tracked sign-off, not failure), never invented (Constitution II).

---

## Phase 1: Setup

**Purpose**: Branch off `dev` for the slice.

- [X] T001 Create the short-lived feature branch `009-reporting-audit-hardening` off `dev` (`git checkout -b 009-reporting-audit-hardening dev`)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared report/audit Zod schemas + reporting period helpers/types, the `onTimeExpr` DRY-for-correctness extraction (+ the behavior-preserving `queryDashboardMetrics` refactor), the package index exports, the nav entry + i18n namespaces, the shared report-shell components (filter bar, provisional banner, the 3-tab Reports page), and the web re-export/hook scaffolding that ALL report/audit stories depend on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Shared (`@brazil-tms/shared`)

- [X] T002 [P] Create `packages/shared/src/schemas/report.ts`: `reportFilterSchema` (`customerId?` uuid, `laneId?` uuid, `from?`/`to?` `z.coerce.date().optional()` ISO date, `groupBy?` `z.enum(["customer","lane"]).default("customer")`) + `reportFromParams(searchParams)` — per contracts/bff-endpoints §1–3, data-model §2
- [X] T003 [P] Extend/create `packages/shared/src/schemas/audit.ts`: `auditLogQuerySchema` (existing `entityType?`/`entityId?`/`action?` **plus new** `actorUserId?` uuid, `from?`/`to?` dates, `limit?` int default 50 max 200, `offset?` int default 0) + `auditLogFromParams(searchParams)` — per contracts/bff-endpoints §4, data-model §5
- [X] T004 [P] Create `packages/shared/src/domain/reporting.ts` (pure, no DB): `defaultReportPeriod(now): { from; to; label }` (last completed calendar month in `America/Sao_Paulo`, Luxon), `monthRangeSaoPaulo(period)`, and the report row **types** `SlaReport`/`SlaReportRow`, `ExceptionReport`, `BillingReadinessReport`, `AuditLogView` — per data-model §2–5
- [X] T005 Add `export *` lines to `packages/shared/src/index.ts` for `./schemas/report`, `./schemas/audit`, `./domain/reporting` (after the existing 008 lines) (depends on T002, T003, T004)

### Database read-layer (`@brazil-tms/db`)

- [X] T006 [P] Create `packages/db/src/trips/on-time.ts`: `onTimeExpr(kind: "pickup" | "arrival"): { actualRecorded: SQL<boolean>; onTime: SQL<boolean> }` — the shared on-time predicate (pickup = `at_origin` event ≤ `planned_pickup_window_end`; arrival = `at_destination` event ≤ `planned_delivery_window_end`; event timestamp = `event_timestamp ?? created_at`) — per data-model §1, research R2 (DRY-for-correctness, clarify Q4)
- [X] T007 Refactor `packages/db/src/trips/trips-read.ts` `queryDashboardMetrics` so on-time pickup/arrival % is sourced from `onTimeExpr` (replace the inline CTE — **behavior-preserving**, same numbers) — per research R2 (depends on T006)
- [X] T008 Add `export *` for `./trips/on-time` to `packages/db/src/index.ts` (the per-report read models + audit-read are exported within their story phases) (depends on T006)

### Web shell + i18n (`apps/web`)

- [X] T009 [P] Extend `apps/web/lib/nav.ts`: add the Reports item `{ key: "reports", href: "/reports", icon: "BarChart3", permission: "view_all_trips" }` to `NAV_ITEMS` — per plan Project Structure
- [X] T010 [P] Extend `apps/web/messages/pt-BR.json`: add the `Reports` (titles, tab labels SLA/Exceções/Prontidão de cobrança, column headers, provisional-banner text) and `AuditView` (filter labels, entity-type presets) namespaces — **nested, no dotted keys** (MEMORY `next_intl_no_dot_in_keys`)
- [X] T011 [P] Create `apps/web/components/reports/report-filters.tsx`: the shared customer/lane/period filter bar (customer + lane selects + from/to date range; defaults to last month) consuming `reportFilterSchema` shape
- [X] T012 [P] Create `apps/web/components/reports/provisional-banner.tsx`: the shared provisional/blocked banner (renders when a report's `provisional` flag is true, showing `provisionalReason`)
- [X] T013 Create `apps/web/lib/trips/reporting.ts` (server-only re-export barrel — stub; stories append their `queryXReport` re-exports) and add report query-hook scaffolding `useSlaReport`/`useExceptionReport`/`useBillingReadinessReport` (poll `60s`, no mutations) to `apps/web/lib/trips/client.ts` (depends on T005)
- [X] T014 Create `apps/web/app/(shell)/reports/page.tsx`: the Reports screen shell with three tabs (SLA · Exceções · Prontidão de cobrança), gated `view_all_trips`, hosting `report-filters` + the provisional banner; each tab body filled by its story (depends on T009, T011, T012)

### Foundational tests

- [X] T015 [P] Create `packages/shared/src/domain/reporting.test.ts` (Vitest, pure): `defaultReportPeriod` returns the last completed calendar month in `America/Sao_Paulo` (DST-safe); `reportFilterSchema`/`auditLogQuerySchema` parse defaults + reject bad input — per plan Testing

**Checkpoint**: Foundation ready — report/audit stories can now proceed (in priority order or in parallel by file).

---

## Phase 3: User Story 1 - Review SLA performance by customer, lane, and period (Priority: P1) 🎯 MVP

**Goal**: A `view_all_trips` user opens Reports → SLA, filters by customer/lane/period, and sees on-time pickup %, on-time arrival %, and on-track/at-risk/late/breached counts (aggregated from stored `trips.sla_status`, on-time via the shared `onTimeExpr`), with a provisional banner when a customer lacks SLA rules.

**Independent Test**: Seed trips with known SLA outcomes for a customer/lane/month; assert the SLA report matches and agrees with the dashboard on overlapping data; assert the provisional banner for a customer with no `customer_sla_rules`; assert non-holder `403`.

### Tests for User Story 1

- [X] T016 [P] [US1] Integration test `apps/web/lib/reporting/sla.test.ts` (Vitest `--project web`, `describe.skipIf(!process.env.DATABASE_URL)`, **static imports** per MEMORY): `querySlaReport` on-time %/state-counts grouped by customer then lane; the on-time % equals the dashboard's `onTimeExpr` result on overlapping data (single-source-of-truth); `provisional: true` when the customer has no `customer_sla_rules`
- [X] T017 [P] [US1] E2E `apps/web/e2e/reports-sla.spec.ts` (Playwright): `GET /api/reports/sla` → holder `200` with the report shape, a token without `view_all_trips` → `403`; the SLA tab renders the provisional banner for a default-policy customer

### Implementation for User Story 1

- [X] T018 [US1] Create `packages/db/src/reporting/sla.ts` exporting `querySlaReport(filters: ReportFilter): Promise<SlaReport>` — reads `trips` (+ `trip_events` via `onTimeExpr`) + `customer_sla_rules` (existence ⇒ `provisional`) + `customers`/`lanes` labels; period membership by `planned_pickup_window_start`; excludes cancelled/archived; SLA-state counts from stored `trips.sla_status` (never re-derived) — per data-model §2, research R2/R3/R8 (depends on T006)
- [X] T019 [US1] Re-export `querySlaReport` from `packages/db/src/index.ts` and `apps/web/lib/trips/reporting.ts` (depends on T018, T013)
- [X] T020 [US1] Create `apps/web/app/api/reports/sla/route.ts`: `GET` → `requireAuth()` → `requirePermission(ctx, "view_all_trips")` → `reportFromParams` → `querySlaReport` → `NextResponse.json(report)`; errors via `handleRouteError` — per contracts/bff-endpoints §1 (depends on T018)
- [X] T021 [P] [US1] Create `apps/web/components/reports/sla-report.tsx`: summary cards (on-time pickup/arrival %, breached count) + TanStack Table (per customer/lane row: total, on-time %s, on-track/at-risk/late/breached) + provisional banner, using `useSlaReport` (no chart lib)
- [X] T022 [US1] Wire `sla-report` into the Reports shell SLA tab (depends on T014, T021)

**Checkpoint**: US1 fully functional — the SLA report is live and independently demoable (the MVP increment).

---

## Phase 4: User Story 2 - Review exception volume and delay reasons (Priority: P2)

**Goal**: A user opens Reports → Exceções and sees exception volume by delay-reason category and severity, open-vs-resolved counts, and average resolution time, grouped by customer/lane/period.

**Independent Test**: Seed exceptions across reason-code categories/severities/states for a customer/month; assert the report's category/severity breakdown, open/resolved counts, and avg resolution time match; assert non-holder `403`.

### Tests for User Story 2

- [X] T023 [P] [US2] Integration test `apps/web/lib/reporting/exceptions.test.ts` (Vitest `--project web`, skipIf no `DATABASE_URL`, static imports): `queryExceptionReport` volume by `reason_codes.category` + severity, open/resolved counts, avg resolution minutes for the period
- [X] T024 [P] [US2] E2E `apps/web/e2e/reports-exceptions.spec.ts`: `GET /api/reports/exceptions` holder `200` / non-holder `403`; the Exceções tab renders the category/severity breakdown

### Implementation for User Story 2

- [X] T025 [US2] Create `packages/db/src/reporting/exceptions.ts` exporting `queryExceptionReport(filters): Promise<ExceptionReport>` — reads `exceptions` + `reason_codes` (category/labelPt) joined to `trips`→`customers`/`lanes`; period membership by `exceptions.opened_at`; `open = status ∈ {open,monitoring}`, `resolved = status = resolved`; `avgResolutionMinutes = avg(resolved_at − opened_at)` over resolved — per data-model §3, research R3
- [X] T026 [US2] Re-export `queryExceptionReport` from `packages/db/src/index.ts` and `apps/web/lib/trips/reporting.ts` (depends on T025)
- [X] T027 [US2] Create `apps/web/app/api/reports/exceptions/route.ts`: `GET` gated `view_all_trips` → `reportFromParams` → `queryExceptionReport` — per contracts/bff-endpoints §2 (depends on T025)
- [X] T028 [P] [US2] Create `apps/web/components/reports/exception-report.tsx`: summary cards (total, open, resolved, avg resolution) + tables (by category, by severity, by customer/lane), using `useExceptionReport`
- [X] T029 [US2] Wire `exception-report` into the Reports shell Exceções tab (depends on T014, T028)

**Checkpoint**: US1 + US2 both work independently.

---

## Phase 5: User Story 3 - Review billing readiness (Priority: P2)

**Goal**: A finance user opens Reports → Prontidão de cobrança and sees phase counts (billing_pending/ready/billed/disputed via the 003 `billingStatus` projection), the completed-but-missing-documents count, and the % of completed trips billing-ready within 24h, with a provisional banner when document/billing rules are unsupplied.

**Independent Test**: Seed trips across the four billing phases + completed-with-missing-docs for a customer/month; assert phase counts, missing-docs count, and %-ready-within-24h match; assert the provisional banner for a default-rules customer; assert non-holder `403`.

### Tests for User Story 3

- [X] T030 [P] [US3] Integration test `apps/web/lib/reporting/billing-readiness.test.ts` (Vitest `--project web`, skipIf no `DATABASE_URL`, static imports): `queryBillingReadinessReport` phase counts via `billingStatus`, `completedMissingDocuments`, `pctReadyWithin24h` (completion→`billing_ready` event gap ≤ 24h), `provisional` flag
- [X] T031 [P] [US3] E2E `apps/web/e2e/reports-billing.spec.ts`: `GET /api/reports/billing-readiness` holder `200` / non-holder `403`; the tab renders phase counts + the provisional banner

### Implementation for User Story 3

- [X] T032 [US3] Create `packages/db/src/reporting/billing-readiness.ts` exporting `queryBillingReadinessReport(filters): Promise<BillingReadinessReport>` — reads `billing_items` (`customer_id`, `billing_period`, missing-proof signal) + `trips` (`billingStatus(current_status)` projection) + `trip_events` (`status_after ∈ {completed, billing_ready}` for the 24h gap); period by `billing_items.billing_period`; `provisional` when per-customer doc/billing rules absent — per data-model §4, research R4/R8
- [X] T033 [US3] Re-export `queryBillingReadinessReport` from `packages/db/src/index.ts` and `apps/web/lib/trips/reporting.ts` (depends on T032)
- [X] T034 [US3] Create `apps/web/app/api/reports/billing-readiness/route.ts`: `GET` gated `view_all_trips` → `reportFromParams` → `queryBillingReadinessReport` — per contracts/bff-endpoints §3 (depends on T032)
- [X] T035 [P] [US3] Create `apps/web/components/reports/billing-readiness-report.tsx`: summary cards (phase counts, completed-missing-docs, % ready within 24h) + per-customer table + provisional banner, using `useBillingReadinessReport`
- [X] T036 [US3] Wire `billing-readiness-report` into the Reports shell Prontidão de cobrança tab (depends on T014, T035)

**Checkpoint**: US1–US3 deliver the three §23 dashboards independently.

---

## Phase 6: User Story 4 - View audit history for critical operational records (Priority: P3)

**Goal**: An Admin (`view_audit_log`) opens Administração → Auditoria and browses/filters the append-only audit trail by entity, actor, action, and date range across the §21.5 record types (status, assignment, document verification, billing, export-batch), with actor names and before/after. The per-trip embedded timeline (005) is unchanged.

**Independent Test**: Trigger one of each §21.5 action type; as Admin filter by actor/action/date-range and assert each appears with actor name + before/after; assert non-admin `403` on the dedicated view while the Trip-Detail embedded timeline still renders under `view_all_trips`.

### Tests for User Story 4

- [X] T037 [P] [US4] Integration test `apps/web/lib/audit/audit-read.test.ts` (Vitest `--project web`, skipIf no `DATABASE_URL`, static imports): `queryAuditLog` honors `actorUserId`/`from`/`to`/`limit`/`offset` filters and joins `actorName`; returns `{ items, total }`
- [X] T038 [P] [US4] Extend `apps/web/e2e/audit.spec.ts`: actor + date-range filters return the expected rows; non-admin (no `view_audit_log`) → `403`; the embedded Trip-Detail timeline remains visible under `view_all_trips`

### Implementation for User Story 4

- [X] T039 [US4] Create/extend `packages/db/src/audit/audit-read.ts` exporting `queryAuditLog(filters): Promise<{ items: AuditLogView[]; total: number }>` — extends the slice-001 read with `actorUserId`/`from`/`to`/pagination and a `users` join for `actorName`; reads only `audit_logs` (append-only, never mutated); uses existing `audit_logs_{entity,actor,created}_idx` — per data-model §5, research R5
- [X] T040 [US4] Re-export `queryAuditLog` from `packages/db/src/index.ts` and create `apps/web/lib/audit/audit-read.ts` (server-only re-export) (depends on T039)
- [X] T041 [US4] Extend `apps/web/app/api/admin/audit-logs/route.ts`: parse the new filters via `auditLogFromParams`, call the extended `queryAuditLog`, return `{ items, total }`; keep `requirePermission(ctx, "view_audit_log")` — per contracts/bff-endpoints §4 (depends on T039)
- [X] T042 [US4] Extend `apps/web/app/(shell)/admin/audit/page.tsx`: add actor + date-range filters and §21.5 entity-type/action presets (status / assignment / document verification / billing / export-batch); add a `useAuditLog` query hook (poll `60s`) in `apps/web/lib/trips/client.ts` — per contracts/bff-endpoints §4 (depends on T041)

**Checkpoint**: All four review surfaces (3 reports + audit view) are independently functional.

---

## Phase 7: User Story 5 - Validate MVP acceptance and harden the system (Priority: P1, release gate)

**Goal**: Prove the §23 acceptance criteria end-to-end and the four hardening bars (permission coverage, audit completeness, localization, performance), recorded in the traceability matrix; §29-gated rows are pass-with-blocked-sign-off.

**Independent Test**: The four hardening suites are green; the traceability matrix has a pass/blocked status for every §23 row; blocked rows are exactly those waiting on §29 inputs.

- [X] T043 [P] [US5] Create `apps/web/e2e/permission-coverage.spec.ts`: for **every operational/billing mutation endpoint across 001–008**, a holder gets `2xx` and a non-holder gets `403` with no state change — covering the keys in contracts/permission-matrix §B.1 (`import_trips`, `edit_trip_plan`/`manage_trips`, `assign_resources`, `update_trip_status`, `cancel_trip`, `create_exceptions`/`resolve_exceptions`, `upload_documents`/`verify_documents`, `mark_completed`/`mark_billing_ready`, `edit_rates`, `export_billing`, `manage_commercial_data`, `manage_users`) — per FR-016 / SC-004
- [X] T044 [P] [US5] Create `apps/web/e2e/audit-completeness.spec.ts`: trigger one of each §21.5 action type (import confirm · plan/execution edit · assignment change · status transition · exception create/resolve · document verification · billing change · export-batch creation · user/permission change) and assert an append-only `audit_logs` row is written (action + actor + before/after where applicable); assert append-only enforcement via `SET LOCAL ROLE` to a SELECT/INSERT-only role (expect SQLSTATE `42501`, MEMORY `append_only_superuser_set_role`) — per FR-017 / SC-005
- [X] T045 [P] [US5] Extend `apps/web/lib/messages.test.ts`: assert the new `Reports`/`AuditView` namespaces are present and **dot-free** (next-intl INVALID_KEY guard, MEMORY), that the `ALL_AUDIT_ACTIONS` → flat `AuditActions[key]` invariant still holds, and a render smoke check that no in-scope screen shows a raw missing-key token — per FR-018 / SC-006
- [X] T046 [US5] Performance validation (quickstart §6): seed a representative customer-month volume; measure each report + the trip list/detail against the §21.2 budgets (reports & list < 3 s, detail < 2 s); if a report misses budget, add the contingent migration `0008_*.sql` (narrowest composite index — research R6) and re-measure; record the numbers for the PR — per FR-019 / SC-002
- [X] T047 [US5] Finalize the §23 traceability matrix in `specs/009-reporting-audit-hardening/contracts/acceptance-and-hardening.md` with the actual pass / pass-with-blocked-sign-off status from the runs; confirm the only blocked rows are §29-input rows (#2 SLA reporting; #3/#4/#5 billing-readiness reporting) — per FR-015 / clarify Q1

**Checkpoint**: The MVP acceptance gate is green; blocked sign-offs are exactly the §29-gated rows.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T048 [P] Run the quickstart.md US-by-US validation (US1–US5) against a seeded dev DB and confirm each independent test passes
- [X] T049 Run the quality gate `pnpm lint && pnpm typecheck && pnpm build && pnpm test` (and the e2e suite against a prod build, `--workers=1`, `db:seed:e2e` first — MEMORY); fix any route-export lint (helpers off `route.ts`, MEMORY `nextjs_route_exports`) or dotted-i18n-key issues — the green gate is the SPEC-SLICING 009 exit criterion
- [X] T050 Open the PR to **`dev`** (never `main`) with the traceability matrix + performance numbers in the description; AI does not merge to `main` (Constitution / DELIVERY-WORKFLOW)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup — **BLOCKS all user stories** (schemas, `onTimeExpr` + dashboard refactor, nav/i18n, the Reports shell, the re-export/hook scaffolding).
- **US1 / US2 / US3 (Phases 3–5)**: depend only on Foundational; independent of each other (each owns its own `reporting/*.ts`, route, component, tab, and tests). They touch the shared `packages/db/src/index.ts` + `apps/web/lib/trips/reporting.ts` re-export barrels and the Reports shell tabs — sequence those re-export/wire tasks if run concurrently.
- **US4 (Phase 6)**: depends only on Foundational; fully independent (audit read/route/screen).
- **US5 (Phase 7)**: the release gate — runs **after** US1–US4 (it validates the assembled MVP + the whole 001–008 surface); P1 by importance, sequenced last by dependency.
- **Polish (Phase 8)**: after all desired stories.

### Within Each User Story

- Tests (the `*.test.ts` + `*.spec.ts`) are written first and FAIL before implementation (TDD).
- Read model (`reporting/*.ts` / `audit-read.ts`) → re-export → route → component → tab wiring.

### Parallel Opportunities

- Foundational [P]: T002, T003, T004 (shared schemas/types); T006 (`onTimeExpr`); T009, T010, T011, T012 (nav/i18n/components); T015 (pure test) — all different files.
- Once Foundational completes, **US1, US2, US3, US4 can proceed in parallel** (different files); only their re-export-barrel and shell-tab-wiring touches are sequential.
- Within a story, the integration test, the e2e spec, and the report component ([P]) parallelize; the read model → route → tab wiring are sequential.
- US5's three e2e/test suites (T043, T044, T045) are [P] (different files).

---

## Parallel Example: User Story 1

```bash
# Tests first (write, ensure they fail):
Task: "Integration test apps/web/lib/reporting/sla.test.ts (querySlaReport)"
Task: "E2E apps/web/e2e/reports-sla.spec.ts (GET /api/reports/sla 200/403 + provisional)"

# Then implementation — the component parallels the read model/route:
Task: "Create apps/web/components/reports/sla-report.tsx"   # [P]
# (querySlaReport → re-export → route → tab wiring run in sequence)
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational (CRITICAL — blocks all stories) → 3. Phase 3 US1 (SLA report).
4. **STOP and VALIDATE**: open Reports → SLA, confirm it matches seeded outcomes and agrees with the dashboard; demo. This is the headline, independently shippable increment.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. US1 (SLA report) → test → demo (MVP).
3. US2 (exceptions) → US3 (billing readiness) → US4 (audit view) — each independently testable.
4. US5 (acceptance + hardening) → the release gate over the assembled MVP.
5. Polish → green CI gate → PR to `dev`.

### Parallel Team Strategy

After Foundational: Dev A → US1, Dev B → US2, Dev C → US3, Dev D → US4 (independent files); reconvene for US5 (the cross-cutting acceptance + hardening gate) once the four surfaces land.

---

## Notes

- This is a **read-only** slice: no new table/enum/migration (default build), permission key, package, worker job, or runtime dependency. The only contingent DDL is migration `0008` of supporting indexes — added in T046 **only if** a measured report misses the §21.2 budget (research R6), and logged.
- Reports reuse `view_all_trips`; the audit view reuses `view_audit_log`; reads are not audited.
- `onTimeExpr` is the single source of truth shared by the dashboard and the SLA report (clarify Q4) — never re-derive SLA classification (Constitution III).
- §29-gated criteria are pass-with-blocked-sign-off with a visible provisional banner — never invented (Constitution II, clarify Q1).
- MEMORY applies: web vitest via `pnpm exec vitest run --project web <file>` with `DATABASE_URL`; route HTTP/authz assertions live in `e2e/` (not `route.test.ts`); e2e against a prod build, `--workers=1`, `db:seed:e2e` first; no dotted i18n keys; helpers off `route.ts`.
- Commit after each task or logical group; stop at any checkpoint to validate a story independently.
