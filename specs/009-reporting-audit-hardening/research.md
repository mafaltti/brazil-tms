# Research & Design Decisions — 009 Reporting, Audit Views, Hardening, and MVP Acceptance

Phase 0 output. The spec's *Clarifications* (specify session + clarify session) already resolved the product-level ambiguities; this file records the **technical** decisions for implementation. There are **no open `NEEDS CLARIFICATION` items** — the slice is read-only over existing data and reuses decided machinery. Format: Decision / Rationale / Alternatives considered.

---

## R0 — Read-only slice: no new durable state

**Decision**: 009 adds **no new table, enum, migration, permission key, package, worker job, or runtime dependency**. Every report is a **synchronous read-model projection** over tables slices 003–008 already own; the audit view extends an existing endpoint.

**Rationale**: SPEC-SLICING 009 scopes the slice to *reporting + audit views + hardening + MVP acceptance* — all of which read existing data. PRD §13.12 reports, §21.5 audit, and §23 dashboards describe **views**, not new entities. Constitution I (YAGNI) and the slice-map note "do not expand into advanced BI" forbid new storage/ETL. Keeping the slice DDL-free also makes it the cleanest possible final-MVP merge (low regression surface).

**Alternatives considered**: (a) **Materialized views / a reporting schema** — rejected: premature at MVP volume (§21.3 "thousands of trips/month"), adds refresh/staleness machinery and violates the no-Realtime/polling model and YAGNI. (b) **A `report_snapshots` table** for cached aggregates — rejected: speculative caching; reports recompute cheaply on read. (c) **A separate reporting DB / data warehouse** — explicitly out of scope (slice map, §10.2 post-MVP).

---

## R1 — Reports live in the existing read-model layer, computed synchronously

**Decision**: Add `querySlaReport` / `queryExceptionReport` / `queryBillingReadinessReport` to `packages/db/src/trips/reporting.ts` (a sibling of 005's `trips-read.ts`), re-exported server-only via `apps/web/lib/trips/reporting.ts`, and called directly from `GET /api/reports/*` handlers — **no worker job, no queue**.

**Rationale**: Mirrors how 005's `queryDashboardMetrics`/`queryTripBoard` and 007's `queryExceptions` already work (STACK §6.2 "BFF owns read models for operational screens"). The aggregates are small (a customer-month slice is hundreds of rows) and finish well within the §21.2 ~3 s budget on the request path. A worker job (like 008's export) is unjustified for sub-second synchronous reads.

**Alternatives considered**: (a) **A new `reporting` package** — rejected: Constitution I (start with `shared`+`db`; no new package without a real reuse/versioning boundary). A new `trips/reporting.ts` module is sufficient. (b) **Worker-precomputed report rows** — rejected: no Realtime, polling is the freshness model, and synchronous reads meet the budget.

---

## R2 — On-time % is extracted once into a shared predicate (DRY-for-correctness)

**Decision**: Extract the on-time pickup/arrival **predicate** currently inlined in `queryDashboardMetrics` (event arrival vs planned window) into one canonical helper `onTimeExpr` (`packages/db/src/trips/on-time.ts`). Both the dashboard metric and `querySlaReport` consume it. On-time pickup = a trip whose recorded `at_origin` event timestamp ≤ `planned_pickup_window_end`; on-time arrival = recorded `at_destination` ≤ `planned_delivery_window_end`; denominator = trips with the relevant actual recorded (the existing dashboard definition: `count(on_time) / count(actual_recorded)`, null when the denominator is 0).

**Rationale**: Clarify Q4 fixes that the SLA report's on-time % MUST **reuse 007's existing computation exactly** so the report and the daily dashboard can never present conflicting numbers (single source of truth). The dashboard computes one company-wide 30-day number; the report needs the **same predicate** grouped by customer/lane and bounded by the selected period. Extracting the predicate (not the whole query) is the **simplest way to satisfy** that constraint — DRY-for-correctness, not speculative abstraction (Constitution I: consolidating an existing computation to prevent divergence). The `queryDashboardMetrics` change is behavior-preserving (same SQL, now sourced from the helper).

**Alternatives considered**: (a) **Re-implement the predicate in the report** — rejected: two definitions drift; clarify Q4 forbids divergence. (b) **Call `queryDashboardMetrics` from the report** — rejected: the dashboard returns a single ungrouped 30-day scalar; the report needs per-customer/lane/period grouping, so only the predicate is shared. (c) **Recompute SLA state in the report** — rejected: Constitution III / STACK §6.1 — final SLA classification (`trips.sla_status`) is owned by 007/the DB; the report *displays* it, it does not re-derive it.

---

## R3 — Period semantics per report (which date buckets a trip)

**Decision**: Default period = **last completed calendar month** in `America/Sao_Paulo`, with a customer + lane + `from`/`to` date-range override (reusing 005's `dayRangeSaoPaulo` and 008's month-of-completion convention). Period **membership** differs by report, by the date that is meaningful to each:
- **SLA report** — by the trip's **planned pickup window date** (the operational date), within the range. Matches the spec edge case "SLA by the planned window's date."
- **Exception report** — by the exception's **`opened_at`** (occurrence date), within the range.
- **Billing-readiness report** — by **`billing_items.billing_period`** (month of completion, the value 008 already stores/derives), filtered by customer + period.

**Rationale**: Each report answers a different question, so each buckets by its own natural timestamp; using one timestamp for all three would misattribute trips (e.g., an exception opened in May on a June-pickup trip belongs to May's exception volume but June's SLA period). Reusing 008's stored `billing_period` keeps the billing-readiness report consistent with the Billing screen and export (§11.7 "customer and billing period").

**Alternatives considered**: A single global "period by completion date" for all reports — rejected: misattributes SLA and exception data; harms test reproducibility and acceptance clarity. (Documented in the spec's Edge Cases as "a trip is counted in exactly one period per report.")

---

## R4 — Billing-readiness "% ready within 24h" is computed from `trip_events`

**Decision**: `% of completed trips billing-ready within 24h` = share of trips completed in the period whose elapsed time **from the `completed` status-change event to the `billing_ready` status-change event** is ≤ 24 hours (clarify Q3). Both timestamps come from the append-only `trip_events` rows (`status_after = 'completed'` / `'billing_ready'`) the 003 `transitionTripStatus` service already writes. Phase counts come from the **`billingStatus(current_status)` projection**; the completed-missing-documents count reuses 008's signal (`billing_items.has-missing-proof` / `queryBillingList`'s `hasMissingProof`).

**Rationale**: Clarify Q3 pins the clock to completion→`billing_ready` (a cycle-time measure matching §9.2 "ready for billing within 24 hours"). `trip_events` is the authoritative, already-written record of both transitions — no new column needed. Reusing the 003 projection keeps billing status single-sourced (FR-010).

**Alternatives considered**: (a) Store a `billing_ready_at` column on `trips`/`billing_items` — rejected: redundant, the event log already has it; no `trips` ALTER (consistent with 008's projection stance). (b) Measure completion→now (aging) — rejected by clarify Q3 (chose cycle-time).

---

## R5 — Audit-history view extends the existing endpoint/screen, not a new build

**Decision**: The "audit history view where not already embedded" (FR-013/014) **extends** the already-shipped `GET /api/admin/audit-logs` (slice 001, gated `view_audit_log`) and its `(shell)/admin/audit/` screen: add `actorUserId`, `from`, `to`, and `limit/offset` filters to `queryAuditLog`, join the **actor name** and an **entity label**, and widen the screen's entity-type presets to the §21.5 record types (status changes, assignment changes, document verification, billing changes, export-batch history). The per-trip audit timeline embedded in Trip Detail (005, `loadTripDetail` → `audit: AuditEntryDto[]`) is **unchanged** and stays on `view_all_trips`.

**Rationale**: The append-only `audit_logs` store, the `view_audit_log` key, the read route, and an admin screen **already exist** — the §21.5 gap is richer **filtering/coverage**, not new infrastructure. The existing indexes (`audit_logs_{entity,actor,created}_idx`) already back entity/actor/date filtering. This is the KISS path (Constitution I) and honors the spec's "where not already embedded" framing (clarify Q2 / FR-013).

**Alternatives considered**: (a) A brand-new audit surface/key — rejected: duplicates 001 and would need a new permission key (the spec forbids). (b) Surfacing audit per-trip only — rejected: §21.5 wants cross-record forensic filtering (by actor/action/date), which the embedded per-trip timeline can't do.

---

## R6 — No migration in the default build; supporting indexes are contingent (YAGNI)

**Decision**: Ship **no migration**. Reports run on existing indexes (`trips_customer_idx`, `trips_pickup_start_idx`, `trips_status_idx`; the fully-indexed `exceptions`; `billing_items_customer_period_idx`; `audit_logs_{entity,actor,created}_idx`). **If** the performance validation (FR-019/SC-002) measures a report missing the §21.2 ~3 s budget at representative volume, add migration `0008_*.sql` with the **narrowest** composite that fixes it — first candidates: `trips(customer_id, planned_pickup_window_start)` (SLA rollup) and/or `trips(customer_id, current_status)` (billing-phase rollup). Any such index MUST be logged (no silent scope).

**Rationale**: Constitution I (YAGNI — no speculative index). At MVP volume a customer-month slice is hundreds of rows; existing single-column indexes on `customer_id` + the pickup-window index make these fast. Adding composites before measuring is premature optimization. Keeping the default build DDL-free is the simplest correct outcome.

**Alternatives considered**: Pre-emptively add the composite indexes — rejected: speculative; measure first. (The candidates are documented so the fallback is a known, bounded `0008` migration, not open-ended work.)

---

## R7 — MVP reports are tabular + summary cards; no charting dependency

**Decision**: Render reports with **TanStack Table** grids + shadcn **summary number cards** (e.g., "On-time pickup: 94% · On-time arrival: 88% · Breached: 3"), in pt-BR. **No charting library** (recharts/visx/Chart.js) is added.

**Rationale**: The §23 acceptance bar and §15.11 require the *numbers* (SLA by customer/lane/period, exception volume by reason, billing-readiness counts) to be reviewable in-system — tables + cards satisfy that. A charting dep is a new runtime dependency (Constitution I needs justification) and adds bundle/maintenance cost for no acceptance-required value. Visualization is a clean Later enhancement.

**Alternatives considered**: Add recharts now — rejected: no acceptance criterion requires charts; defer (KISS / no new dep).

---

## R8 — Provisional/blocked surfacing when §29 inputs are absent

**Decision**: When a selected customer has **no `customer_sla_rules`** row, `querySlaReport` computes on `DEFAULT_SLA_POLICY` (007's constant) and returns a `provisional: true` flag with a reason; the SLA report renders a visible **"Provisional — pendente de regras de SLA do cliente"** banner. When per-customer document/billing rules are absent (the default checklist / manual values path from 008), `queryBillingReadinessReport` returns `provisional: true`; the report renders **"Provisional — pendente de regras de cobrança/documentos"**. The MVP-acceptance traceability records the affected §23 criteria as **pass-with-blocked-sign-off** (clarify Q1), not failures.

**Rationale**: Constitution II forbids inventing §29 inputs; the slice ships on documented defaults and surfaces the blocked sign-off explicitly (spec's *Blocked* section, FR-007/FR-012/FR-015). Carrying the flag in the read model (not the UI) keeps the determination server-side (Constitution III).

**Alternatives considered**: Hide reports until inputs arrive — rejected: the reports are buildable and useful on defaults; blocking visibility defeats the Phase-5 goal. Present provisional figures as final — rejected: misleading; Constitution II.

---

## R9 — The hardening pillar is tests + deliverable docs, not runtime features

**Decision**: Deliver the four §22-Phase-5/§23 quality bars as artifacts:
- **Permission coverage** → `e2e/permission-coverage.spec.ts`: for every operational/billing **mutation** endpoint across 001–008, assert a holder gets `2xx` and a non-holder gets `403` (+ no state change). Backed by `contracts/permission-matrix.md` and the matrix in `contracts/acceptance-and-hardening.md`.
- **Audit completeness** → `e2e/audit-completeness.spec.ts`: trigger one of each §21.5 action type and assert an append-only `audit_logs` row is written (action + actor + before/after where applicable).
- **Localization coverage** → EXTEND `apps/web/lib/messages.test.ts`: the new `Reports`/`AuditView` namespaces present + dot-free; the `ALL_AUDIT_ACTIONS`→flat-label invariant holds; a render smoke check that no screen shows a missing-key token.
- **Performance** → a recorded validation (quickstart procedure) measuring each report + trip-list/detail against seeded volumes vs the §21.2 budgets.

**Rationale**: These bars are *verifications of the assembled MVP*, not new product surface; the right shape is tests (the CI gate) + a traceability doc. STACK §3.13 names permission checks and billing-readiness rules as Vitest/Playwright focuses; this slice closes the coverage loop. The green CI gate is itself the SPEC-SLICING 009 exit criterion.

**Alternatives considered**: A runtime "acceptance dashboard" — rejected: speculative product surface for a one-time release gate; a doc + test suite is simpler and is the artifact reviewers actually use.

---

## R10 — MVP acceptance traceability is a living matrix mapping §23 → PRD IDs → slice → verification

**Decision**: Maintain the §23 acceptance matrix (drafted in spec.md) in `contracts/acceptance-and-hardening.md`, each row carrying PRD requirement IDs, owning slice, verification method (the concrete test/flow), and a **pass / pass-with-blocked-sign-off** status. The slice's Definition of Done is: all §23 rows pass (blocked-sign-off rows count as pass per clarify Q1), the four hardening suites are green, and the CI gate (lint/typecheck/build/tests) passes.

**Rationale**: The user constraint and §23 require an explicit traceability section mapping acceptance criteria back to PRD IDs; clarify Q1 fixed that §29-gated rows are pass-with-blocked-sign-off, not failures. Keeping it in `contracts/` makes it the reviewable release artifact.

**Alternatives considered**: Leave traceability only in spec.md prose — rejected: the plan needs an actionable, test-linked matrix for `/speckit-tasks` to generate verification tasks against.
