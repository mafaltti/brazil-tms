# Feature Specification: Reporting, Audit Views, Hardening, and MVP Acceptance

**Feature Branch**: `009-reporting-audit-hardening`

**Created**: 2026-06-01

**Status**: Draft

**Input**: User description: "Business users can review SLA, exception, and billing readiness performance without relying on external spreadsheets as the system of record. Reports show SLA by customer, lane, and period; exception volume and delay reasons; and billing readiness. Audit history is visible for critical operational records where not already embedded. Performance, permission coverage, audit completeness, localization coverage, and UAT fixes are part of this feature, and the full MVP acceptance criteria (PRD §23) are validated end to end with a traceability matrix back to PRD requirement IDs. Per-customer SLA rules affect final SLA reporting sign-off; billing and document rules affect final billing-readiness reporting sign-off. Out of scope: lane performance report beyond MVP, carrier scorecard, profitability dashboard, advanced BI / data-warehouse work. Do not invent missing customer, SLA, document, or billing details — make behavior configurable and mark final sign-off as blocked."

**Source PRD sections**: §9 (Success Metrics), §13.10 (SLA-005), §13.12 (REP-002/003/004), §15.11 (Reports screen), §17 (alert case 8 input), §18 (Permissions), §21 (Non-Functional Requirements — Performance, Security, Auditability, Localization), §22 (Phase 5 — Reports and Hardening), §23 (MVP Acceptance Criteria), §24 (Risks), §29 (Inputs #2–#5), §30

**Primary requirement IDs**: SLA-005, REP-002, REP-003, REP-004

**Slice ownership**: This is the **performance-visibility, hardening, and MVP-acceptance close-out** over the whole trip domain — slice 009 in `docs/SPEC-SLICING.md`, the final MVP slice. It owns: the **Reports** screen (`Relatórios`, §15.11) with the three MVP-acceptance reports — **SLA performance by customer/lane/period** (SLA-005, REP-002), **exception volume and delay reasons** (REP-003), and **billing readiness** (REP-004); the dedicated **audit-history views** for critical operational records **where not already embedded** in Trip Detail (§13.12, §21.5); and the cross-cutting **hardening + MVP-acceptance** pillar (§22 Phase 5, §23) — performance validation (§21.2), permission-coverage proof (§18, §21.4), audit-completeness proof (§21.5), localization-coverage proof (§21.6), UAT fixes, and an end-to-end **MVP acceptance validation workflow** with a **traceability matrix** mapping every §23 criterion back to PRD requirement IDs and owning slice. It **reuses, never redefines**: the 005 read-model layer and dashboard conventions (`queryDashboardMetrics`/`queryTripBoard`/`exportTripRows` in `packages/db/src/trips/trips-read.ts`, the `DEFAULT_TRIP_VIEWS` view registry, the `apps/web/lib/nav.ts` navigation registry that has **no Reports entry yet**), the 007 **SLA state** (`trips.sla_status`/`trips.sla_reasons`, the `evaluateSlaRisk` pure evaluator, the `customer_sla_rules` precedence + `DEFAULT_SLA_POLICY`) and **exception model** (`exceptions` + `reason_codes`, the `exception_severity`/`exception_status` enums and the 12 reason-code categories) and the in-app **`alerts` store**, the 008 **billing items** (`billing_items`/`billing_adjustments`, the `document_checks` completed-but-missing-documents sweep) and the 003 **`billingStatus(current_status)` projection**, and the 001 **append-only audit foundation** (`audit_logs` + `trip_events`, the `writeAudit` helper, REVOKE-enforced append-only) with its **`view_audit_log`** permission key and the `next-intl` **pt-BR** message catalog. Authorization adds **NO new permission key, table, enum, package, worker process, runtime dependency, or worker job**: reports and report reads are gated by the existing **`view_all_trips`** (all seven internal roles — mirroring the 005 dashboard), the dedicated audit-history views are gated by the existing **`view_audit_log`** (Admin — enforced since 001), and per-customer SLA rules / document requirements continue to be administered under **`manage_commercial_data`** (002). Reporting is **read-only projections** over the existing tables (no new tables/enums — any supporting index or `reporting` read-model module is a `/speckit-plan` detail), computed **synchronously** on read (no new worker job — unlike 008's export), with freshness by **polling via TanStack Query** (never Realtime, STACK §3.10). Open items are **gated business inputs, not blockers and not invented** (Constitution II): per-customer SLA rules (§29 Input #2 — SLA reporting runs on `DEFAULT_SLA_POLICY` with a visible *provisional* indicator and **final SLA reporting sign-off blocked** until supplied) and the per-customer document/billing rules (§29 Inputs #3/#4/#5 — billing-readiness reporting runs on the default checklist + manual values and **final billing-readiness reporting sign-off blocked** until supplied). It builds on `specs/001-platform-access-shell/` (auth, the `audit_logs`/`view_audit_log` foundation, i18n/pt-BR), `specs/002-master-data-config/` (customers/lanes/vehicle types; `manage_commercial_data`), `specs/003-trip-domain-lifecycle/` (the `trip_status` machine + `billingStatus` projection + append-only `trip_events`), `specs/005-control-tower/` (the read-model layer, the daily dashboard REP-001, the nav/view registry, and the REP-005 trip-list export this slice does **not** duplicate), `specs/007-execution-events-exceptions/` (the SLA state, exception/reason-code model, and `alerts` store this slice reports over), and `specs/008-documents-billing-export/` (the billing items, document checklists, and completed-missing-documents signal this slice reports over).

## Overview & Intent *(why this feature exists)*

Slices 001–008 take a trip from import through dispatch, execution, exceptions, completion, proof, and billing export — and slices 005/007/008 already deliver the **live operating surfaces**: the daily Home Dashboard (REP-001), at-risk/SLA indicators on the Control Tower, the exception board, and the billing-pending widgets. What is still missing is the **review surface**: a way for **business users** (operations managers, finance analysts, executives) to step back from the live board and answer *"how did we perform last month?"* — SLA by customer and lane, exception volume and why trips were late, and how much revenue is stuck short of billing-ready — **inside the system**, so the spreadsheet stops being the system of record (the explicit §22 Phase 5 exit criterion and the §24 risk: "operational users keep using spreadsheets → system data becomes incomplete").

This is the **last MVP slice**, so it carries a second, equally important job: **hardening and MVP acceptance**. It is the slice where the §23 acceptance criteria are validated **end to end** and where the cross-cutting quality bars are proven rather than assumed — that every operational and billing mutation **rejects unauthorized roles** (§23, §18, §21.4), that every critical change **appears in audit history** (§23, §21.5), that the UI is **fully pt-BR** (§21.6), and that the system **performs** at daily operating volumes (§21.2). The deliverable is not just screens; it is a **traceability matrix** that maps each §23 acceptance criterion to its PRD requirement IDs and owning slice, with a recorded **pass / blocked** status for each.

The value is **trustworthy, in-system performance review and a defensible release gate**. The mechanism is **reuse, not new machinery**: the reports are thin **read-only projections** over data that slices 003–008 already produce — `trips.sla_status` (007), `exceptions`/`reason_codes` (007), the `billingStatus` projection (003) and `billing_items` (008), and the completed-missing-documents signal (008's `document_checks` sweep) — computed synchronously on read and refreshed by polling. No Realtime, no new worker job, no new table, no advanced BI engine, no data warehouse (those are explicitly Later / out of scope). Customer variation stays **config-driven**: SLA reporting reflects whatever per-customer SLA rules are in force (or the documented default), and billing-readiness reporting reflects whatever document/billing rules are in force (or the documented defaults) — never per-customer report code.

Where a business input is missing it is made **configurable with an explicit default and the affected sign-off marked blocked** — never invented (Constitution II): per-customer SLA rules (§29 Input #2) gate **final SLA reporting sign-off**, and per-customer document/billing rules (§29 Inputs #3/#4/#5) gate **final billing-readiness reporting sign-off**. The slice ships and is testable on the documented defaults, and reports each affected sign-off as **blocked** until the business supplies the real inputs.

## Clarifications

### Session 2026-06-01 *(design decisions resolved while specifying; informed defaults — business-input gaps are recorded under "Blocked / Open for business sign-off")*

- Q: Does this slice add any new permission key for reports or audit views? → A: **No new key.** Reports and all report reads reuse **`view_all_trips`** (all seven internal roles — mirroring the 005 dashboard, which already gates `queryDashboardMetrics` on this key). The dedicated **audit-history views** reuse **`view_audit_log`** (Admin — the only audit key, enforced since 001, per least-privilege §21.4); per-trip audit history **already embedded** in Trip Detail (005) stays on `view_all_trips`. Per-customer SLA rules and document requirements continue to be administered under **`manage_commercial_data`** (002). No `view_reports`/`view_audit`/`manage_reports` key exists or is added.
- Q: Is reporting a new data layer (tables, materialized views, ETL, a reporting DB)? → A: **No.** Reporting is **read-only Drizzle projections** over the existing operational tables, co-located with the 005 read-model layer (`packages/db/src/.../*-read.ts`); the spec fixes the **behavior** (what each report shows and how it groups), the physical decomposition (a dedicated `reporting` module vs extending `trips-read.ts`, and any supporting index) is left to `/speckit-plan`. **No materialized views, no separate reporting database, no ETL** (YAGNI, Constitution V; "do not expand into advanced BI", slice map).
- Q: Are reports computed on the worker or synchronously on read? → A: **Synchronously on read** — they aggregate daily operating volumes (§21.3 "thousands of trips per month") within the §21.2 performance budget; **no new worker job** is added (unlike 008's on-demand export). Freshness is **polling via TanStack Query**, never Realtime (STACK §3.10).
- Q: What is the reporting **period**, and what dimensions do reports group by? → A: **Calendar month in `America/Sao_Paulo`** is the default period, with a customer + lane + date-range filter; reports group by **customer**, **lane**, and **period** (SLA-005/§15.11). This reuses 008's billing-period (month of completion) and 005's BRT day-range conventions. Timestamps are stored UTC and displayed in `America/Sao_Paulo`.
- Q: What does the **SLA performance report** show, and where does its data come from? → A: On-time pickup % and on-time arrival % plus on-track / at-risk / late / breached counts, grouped by customer/lane/period — read from the **`trips.sla_status`/`trips.sla_reasons`** state that 007 already maintains (the `evaluateSlaRisk` evaluator over per-customer `customer_sla_rules`). The report **does not recompute or redefine** SLA logic; it aggregates the stored state. *(SLA-005, REP-002, §9.1)*
- Q: What does the **exception report** show? → A: Exception **volume** and **delay-reason** breakdown grouped by customer/lane/period, decomposed by **reason-code category** (the 12 §13.8 categories from 007's `reason_codes`) and **severity**, plus open-vs-resolved counts and average resolution time (§9.1 "average exception resolution time"). Reads the 007 `exceptions` + `reason_codes` tables. *(REP-003, §13.12)*
- Q: What does the **billing-readiness report** show? → A: Counts by billing phase — `billing_pending` / `billing_ready` / `billed` / `disputed` via the 003 **`billingStatus(current_status)` projection** — plus the **completed-but-missing-documents** count (008's `document_checks` signal / §9.1) and the **% of completed trips billing-ready within 24h** (§9.2 financial metric), grouped by customer/period. It is **readiness-focused**, not a revenue/profitability report. *(REP-004, §9.2)*
- Q: Which audit views does this slice add, given 005 already embeds per-trip audit history? → A: A **dedicated audit-history view** (gated `view_audit_log`, Admin) for **critical operational records where not already embedded** — letting an authorized user browse/filter the append-only `audit_logs` + `trip_events` by entity, actor, action, and date range across the §21.5 list (imported-data edits, status changes, assignment changes, exception creation/resolution, **document verification**, **billing changes**, **export batch history**). The per-trip timeline already on Trip Detail (005) is **not** duplicated.
- Q: Does the slice export the aggregate reports to CSV/spreadsheet? → A: **Out of MVP scope.** Raw trip-list extraction is already 005's **REP-005** (`exportTripRows`); the §23 acceptance bar requires the reports to *replace* spreadsheets as the review surface, not to round-trip back to them. Aggregate-report export is recorded under Future Enhancements and is **not** in this slice's acceptance bar. *(Scope guard: "do not expand reports beyond what is needed for MVP acceptance".)*
- Q: Are revenue-by-customer/lane, carrier performance, and lane performance (listed in §15.11) delivered here? → A: **No.** §15.11 lists them, but they map to **REP-006/007/008** (Later) and the profitability dashboard; the §23 acceptance bar names only SLA performance, exceptions, and billing readiness. They are **deferred** (Future Enhancements), and the Reports screen ships only the MVP-acceptance reports.
- Q: What does the **MVP acceptance validation** deliverable consist of? → A: An end-to-end run of **every §23 criterion** producing a **traceability matrix** (criterion → PRD requirement IDs → owning slice → verification method → pass/blocked) plus four hardening proofs — a **permission-coverage** matrix (every BFF operational/billing mutation: authorized success + unauthorized 403), an **audit-completeness** check (every §21.5 action type produces an audit record), a **localization-coverage** audit (zero missing pt-BR keys; BRL/Brazil date/timezone), and a **performance** validation against representative seed volumes (§21.2 budgets). UAT-discovered defects are fixed within scope; out-of-scope findings are logged as deferred.

### Session 2026-06-01 *(clarify pass — answers locked before planning via `/speckit-clarify`)*

- Q: When a §29 business input (per-customer SLA rules, or document/billing rules) is still outstanding, how should the MVP acceptance workflow treat the affected §23 criterion? → A: **Pass with blocked sign-off** — the criterion is verified end to end on the documented defaults and **release is permitted**; the affected business **sign-off** (SLA reporting; billing-readiness reporting) is tracked **separately as blocked** until the §29 inputs arrive (Constitution II). "Blocked" is a sign-off state, **not** an acceptance failure. *(refines FR-015, SC-003, Blocked section)*
- Q: Who can open the dedicated audit-history view for critical operational records? → A: **Admin only**, via the existing **`view_audit_log`** key (least privilege, §21.4); per-trip audit history stays embedded on Trip Detail for all `view_all_trips` roles. Broadening `view_audit_log` membership (e.g., to Finance for billing-change forensics) is deferred as a role-grant decision and is **not** done in this slice. *(confirms FR-013)*
- Q: For "% of completed trips billing-ready within 24 hours" (§9.2), the 24-hour clock runs from when to when? → A: **From the trip's completion timestamp to its `billing_ready` transition** — a trip counts as "within 24h" when that elapsed gap is ≤ 24 hours (a cycle-time measure). *(refines FR-011, US3 scenario 2)*
- Q: How is the SLA report's on-time pickup/arrival % defined relative to the on-time % the 005/007 daily dashboard already computes? → A: **Reuse 007's existing on-time computation exactly** (the same denominator and window used by `queryDashboardMetrics`), so the report and the dashboard never present conflicting numbers — single source of truth; the report aggregates that computation by customer/lane/period and does **not** redefine the denominator. *(refines FR-006)*

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Review SLA performance by customer, lane, and period (Priority: P1)

A business user (operations manager, finance analyst, or executive) opens the **Reports** screen and the **SLA performance** report, filters by **customer**, **lane**, and **period** (default: last calendar month, `America/Sao_Paulo`), and sees **on-time pickup %**, **on-time arrival %**, and the breakdown of trips by SLA state (on-track / at-risk / late / breached) for the selection — read from the SLA state slice 007 already maintains, with no spreadsheet involved. Where the selected customer has **no per-customer SLA rule** on file, the figures are computed on the documented default policy and the report shows a visible **"provisional — pending customer SLA sign-off"** indicator.

**Why this priority**: This is the headline outcome and an explicit §23 acceptance criterion ("Dashboards show … SLA performance …") and the SLA-005/REP-002 requirement. It is the first surface that lets the business retire the SLA spreadsheet, and it is independently shippable and valuable on its own.

**Independent Test**: Seed trips for two customers across two lanes in a known month with deterministic on-time/late/breached outcomes (via 007's SLA state). As a user with `view_all_trips`, open Reports → SLA, filter to customer A / lane X / that month; assert on-time pickup %, on-time arrival %, and the on-track/at-risk/late/breached counts match the seeded outcomes, grouped by customer and lane. Assert a customer with no `customer_sla_rules` row renders with a visible provisional indicator. Assert a user **without** `view_all_trips` cannot open the report.

**Acceptance Scenarios**:

1. **Given** seeded trips with known SLA outcomes for a customer/lane/month, **When** a user with `view_all_trips` opens the SLA report filtered to that customer/lane/period, **Then** it shows on-time pickup %, on-time arrival %, and on-track/at-risk/late/breached counts aggregated from `trips.sla_status`. *(SLA-005, REP-002, §9.1)*
2. **Given** the same data, **When** the user changes the grouping dimension (customer → lane) or the period, **Then** the figures regroup accordingly without leaving the system or exporting to a spreadsheet. *(SLA-005, §15.11)*
3. **Given** a customer with **no per-customer SLA rule** on file, **When** the SLA report is viewed for that customer, **Then** figures are computed on the documented default policy and a visible **provisional / sign-off-blocked** indicator is shown. *(§29 Input #2, Constitution II)*
4. **Given** a user **without** `view_all_trips`, **When** they attempt to open the Reports screen, **Then** access is refused. *(§18, §21.4)*

---

### User Story 2 - Review exception volume and delay reasons (Priority: P2)

A business user opens the **exception** report, filters by customer/lane/period, and sees **exception volume** broken down by **delay-reason category** (the §13.8 reason-code categories), by **severity**, and by **open vs resolved**, with **average resolution time** — so they can see *why* trips are late and *how fast* exceptions get closed, without compiling it by hand.

**Why this priority**: An explicit §23 acceptance criterion ("Dashboards show … exceptions") and the REP-003 requirement; it is P2 because it builds on the same Reports shell and read-model conventions as US1 and is independently valuable once US1's surface exists.

**Independent Test**: Seed exceptions across reason-code categories, severities, and open/resolved states for a customer/month (via 007's `exceptions`/`reason_codes`). Open Reports → Exceptions, filter to that customer/month; assert volume by reason-code category and severity, open-vs-resolved counts, and average resolution time match the seed. Assert grouping by customer vs lane regroups correctly.

**Acceptance Scenarios**:

1. **Given** seeded exceptions with reason codes and severities for a customer/period, **When** the exception report is viewed, **Then** it shows exception volume grouped by customer/lane/period and decomposed by reason-code category and severity. *(REP-003, §13.8, §13.12)*
2. **Given** a mix of open and resolved exceptions, **When** the report is viewed, **Then** it shows open-vs-resolved counts and the average resolution time for the selection. *(REP-003, §9.1)*

---

### User Story 3 - Review billing readiness (Priority: P2)

A finance user opens the **billing-readiness** report, filters by customer/period, and sees how many completed trips are **billing-pending / billing-ready / billed / disputed**, how many are **completed but missing required documents**, and the **% of completed trips billing-ready within 24 hours** — so finance can see revenue at risk of leakage without a spreadsheet. Where the per-customer document/billing rules are unsupplied, the report runs on the default checklist + manual values and shows a visible **"provisional — pending billing/document sign-off"** indicator.

**Why this priority**: An explicit §23 acceptance criterion ("Dashboards show … billing readiness") and the REP-004 requirement; P2 for the same reason as US2 — it reuses the Reports shell and the 003 `billingStatus` projection + 008 billing data.

**Independent Test**: Seed trips across the four billing phases plus completed-with-missing-documents (via 003's projection + 008's billing items / `document_checks` signal). Open Reports → Billing Readiness, filter to a customer/month; assert phase counts, the completed-missing-documents count, and the %-ready-within-24h match the seed. Assert a customer with no document/billing rules renders the provisional indicator.

**Acceptance Scenarios**:

1. **Given** seeded trips across billing phases for a customer/period, **When** the billing-readiness report is viewed, **Then** it shows counts by `billing_pending`/`billing_ready`/`billed`/`disputed` via the 003 `billingStatus` projection. *(REP-004, BILL-001)*
2. **Given** completed trips with required documents missing, **When** the report is viewed, **Then** it shows the completed-but-missing-documents count and the % of completed trips billing-ready within 24 hours. *(REP-004, §9.1, §9.2)*
3. **Given** a customer with **no document/billing rules** on file, **When** the report is viewed, **Then** it runs on defaults/manual values and shows a visible **provisional / sign-off-blocked** indicator. *(§29 Inputs #3/#4/#5, Constitution II)*

---

### User Story 4 - View audit history for critical operational records (Priority: P3)

An authorized user (Admin, `view_audit_log`) opens a **dedicated audit-history view** and browses/filters the append-only audit trail for critical operational records — by entity, actor, action, and date range — covering the §21.5 list: imported-data edits, status changes, assignment changes, exception creation/resolution, **document verification**, **billing changes**, and **export batch history**. The per-trip audit timeline already shown on Trip Detail (005) is unaffected and remains visible to `view_all_trips`.

**Why this priority**: §23 requires "Critical changes appear in audit history" and §13.12/§21.5 require audit visibility; it is P3 because much of the per-record audit is **already embedded** in Trip Detail (005), so this slice only fills the **dedicated/cross-record** view gap.

**Independent Test**: Trigger one of each §21.5 action type via existing slice flows (status change, assignment, exception resolve, document verify, billing change, export). As Admin (`view_audit_log`), open the audit view and filter by entity/actor/action/date; assert each action appears with actor, timestamp, action type, and before/after where applicable, sourced from the append-only `audit_logs`/`trip_events`. Assert a non-Admin user is refused the dedicated audit view, and that the Trip-Detail embedded timeline still renders for `view_all_trips`.

**Acceptance Scenarios**:

1. **Given** a critical change of each §21.5 type, **When** an Admin opens the audit view and filters by entity/actor/action/date range, **Then** each change is listed with actor, timestamp, action, and before/after values where applicable, read from the append-only audit store. *(§21.5, §13.12)*
2. **Given** a user **without** `view_audit_log`, **When** they attempt to open the dedicated audit view, **Then** access is refused; the per-trip audit history embedded in Trip Detail remains visible under `view_all_trips`. *(§18, §21.4)*

---

### User Story 5 - Validate MVP acceptance and harden the system (Priority: P1)

The team runs the **MVP acceptance validation workflow**: every §23 acceptance criterion is exercised end to end and recorded in a **traceability matrix** (criterion → PRD requirement IDs → owning slice → verification method → pass/blocked); and the four cross-cutting hardening bars are proven — **permission coverage** (every BFF operational/billing mutation rejects unauthorized roles and allows authorized ones), **audit completeness** (every §21.5 action type produces an audit record), **localization coverage** (zero missing pt-BR keys; BRL/Brazil date/timezone), and **performance** (§21.2 budgets hold at representative volumes). UAT-discovered defects are fixed within scope; anything beyond MVP scope is logged as deferred.

**Why this priority**: This is the feature's defining deliverable and the MVP **release gate** (§22 Phase 5, §23) — the reason the slice exists alongside the reports. It is P1 as the exit pillar; it is independently testable as a validation artifact (the matrix + the four proofs) that runs over whatever the MVP currently ships.

**Independent Test**: Produce the traceability matrix covering all §23 criteria with a pass/blocked status and PRD-ID mapping; run the permission-coverage suite (authorized success + unauthorized 403 for each operational/billing mutation across 001–008); run the audit-completeness check over the §21.5 list; run the localization-coverage audit; run the performance validation against seeded daily volumes. Assert each proof is complete and that blocked items are exactly those waiting on §29 business inputs.

**Acceptance Scenarios**:

1. **Given** the assembled MVP, **When** the acceptance workflow is run, **Then** every §23 criterion has a recorded pass or an explicit **blocked-on-business-input** status, mapped to its PRD requirement IDs and owning slice in the traceability matrix. *(§23, §22 Phase 5)*
2. **Given** the permission matrix (§18), **When** the permission-coverage suite runs, **Then** every operational and billing **mutation** endpoint allows authorized roles and returns 403 for unauthorized roles. *(§23, §18, §21.4)*
3. **Given** the §21.5 critical-action list, **When** the audit-completeness check runs, **Then** each action type is shown to produce an append-only audit record. *(§23, §21.5)*
4. **Given** the pt-BR build, **When** the localization-coverage audit runs, **Then** no user-facing screen has a missing translation key and currency/date/time render in BRL / Brazil format / `America/Sao_Paulo`. *(§21.6)*
5. **Given** representative seed volumes, **When** the performance validation runs, **Then** the §21.2 budgets hold (trip list < 3s, trip detail < 2s, reports responsive for common filters). *(§21.2)*

---

### Edge Cases

- **Empty selection**: a report filtered to a customer/lane/period with no matching trips shows an explicit "no data for this selection" state, not a blank or an error.
- **Missing per-customer SLA rule**: SLA figures fall back to `DEFAULT_SLA_POLICY` and the report is flagged **provisional**; it is never silently presented as signed-off (§29 Input #2).
- **Missing document/billing rules**: billing-readiness figures fall back to the default checklist + manual values and the report is flagged **provisional** (§29 Inputs #3/#4/#5).
- **Partial period**: a period that is still in progress (e.g., the current month) is labeled as in-progress so "% ready within 24h" is not misread as final.
- **Trip spanning a month boundary**: period membership follows the documented rule (SLA by the planned window's date; billing readiness by month of completion, reusing 008) so a trip is counted in exactly one period per report.
- **Soft-deleted / archived records**: archived trips, documents, and billing items are excluded from operational counts but remain reachable in the audit view (append-only history is never hidden).
- **Audit view scale**: filtering the audit view across years of history (§21.3 "historical reporting across years") stays within the performance budget via date-range scoping.
- **Unauthorized access**: a user lacking `view_all_trips` cannot reach Reports; a user lacking `view_audit_log` cannot reach the dedicated audit view, even though they may see the embedded Trip-Detail timeline.

## Requirements *(mandatory)*

### Functional Requirements

**Reports surface**

- **FR-001**: System MUST add a **Reports** screen (`Relatórios`) to the navigation registry, gated by the existing **`view_all_trips`** permission (all seven internal roles), without adding a new permission key.
- **FR-002**: The Reports screen MUST present the three MVP-acceptance reports — **SLA performance**, **exception volume / delay reasons**, and **billing readiness** — and MUST NOT present revenue-by-customer/lane, carrier performance, lane performance, or profitability reports (those are deferred: REP-006/007/008).
- **FR-003**: Every report MUST support filtering by **customer**, **lane**, and **period**, where **period** defaults to the last calendar month in `America/Sao_Paulo` and supports a date-range selection; reports MUST group by customer, lane, and period as applicable.
- **FR-004**: Reports MUST be **read-only projections** over existing operational data — viewing a report MUST NOT mutate any record — and MUST NOT introduce a new table, enum, materialized view, reporting database, ETL pipeline, or worker job.
- **FR-005**: Report freshness MUST be **polling via TanStack Query** (no Realtime); reports MUST render all monetary values in **BRL**, dates/times in **Brazil format** and `America/Sao_Paulo`, and all labels in **pt-BR**.

**SLA performance report (SLA-005, REP-002)**

- **FR-006**: The SLA report MUST show **on-time pickup %**, **on-time arrival %**, and counts of trips by SLA state (**on-track / at-risk / late / breached**) for the selected customer/lane/period, **aggregated from the existing `trips.sla_status`/`trips.sla_reasons` state** maintained by slice 007 — it MUST NOT redefine or recompute SLA logic. On-time pickup % and on-time arrival % MUST **reuse slice 007's existing on-time computation** (the same denominator and window used by the daily dashboard's `queryDashboardMetrics`), aggregated by customer/lane/period, so the report and the dashboard never present conflicting figures (single source of truth).
- **FR-007**: When the selected customer has **no per-customer SLA rule** on file, the SLA report MUST compute on the documented default policy and display a visible **provisional / "pending customer SLA sign-off"** indicator; final SLA reporting sign-off MUST be reported **blocked** until the rules are supplied (§29 Input #2).

**Exception report (REP-003)**

- **FR-008**: The exception report MUST show **exception volume** for the selected customer/lane/period, decomposed by **delay-reason category** (the §13.8 reason-code categories) and by **severity**, reading the existing `exceptions` + `reason_codes` data (slice 007).
- **FR-009**: The exception report MUST show **open-vs-resolved** counts and the **average exception resolution time** (§9.1) for the selection.

**Billing-readiness report (REP-004)**

- **FR-010**: The billing-readiness report MUST show trip counts by billing phase (**billing_pending / billing_ready / billed / disputed**) via the existing **`billingStatus(current_status)` projection** (slice 003), for the selected customer/period.
- **FR-011**: The billing-readiness report MUST show the **completed-but-missing-required-documents** count (reusing slice 008's `document_checks` signal) and the **% of completed trips billing-ready within 24 hours** (§9.2), where the 24-hour measure is the elapsed time from a trip's **completion timestamp to its `billing_ready` transition** (a trip counts as within-24h when that gap is ≤ 24 hours — a cycle-time measure).
- **FR-012**: When the per-customer document/billing rules are unsupplied, the billing-readiness report MUST run on the default checklist + manual values and display a visible **provisional / "pending billing & document sign-off"** indicator; final billing-readiness reporting sign-off MUST be reported **blocked** until supplied (§29 Inputs #3/#4/#5).

**Audit history views**

- **FR-013**: System MUST provide a **dedicated audit-history view** for critical operational records **where not already embedded** in Trip Detail, gated by the existing **`view_audit_log`** permission (Admin), reading the **append-only** `audit_logs` + `trip_events` stores; it MUST support filtering by entity, actor, action, and date range.
- **FR-014**: The audit view MUST cover the §21.5 critical-record list — imported-data edits, status changes, assignment changes, exception creation/resolution, **document verification**, **billing changes**, and **export batch history** — showing actor, timestamp, action, and before/after values where applicable; it MUST NOT duplicate the per-trip timeline already on Trip Detail and MUST NOT mutate or permit deletion of audit history.

**Hardening & MVP acceptance**

- **FR-015**: System MUST deliver an **MVP acceptance validation** covering **every §23 criterion** end to end, recorded in a **traceability matrix** mapping each criterion to its PRD requirement IDs, owning slice, verification method, and a **pass / blocked** status. A criterion whose **only** outstanding dependency is a §29 business input MUST be recorded as **pass-with-blocked-sign-off** — verified on the documented defaults, with **release permitted** and the business sign-off tracked separately as blocked — **not** as an acceptance failure.
- **FR-016**: System MUST deliver a **permission-coverage** proof showing that every BFF **operational and billing mutation** endpoint (across slices 001–008) allows authorized roles and returns **403** for unauthorized roles (§18, §21.4, §23).
- **FR-017**: System MUST deliver an **audit-completeness** proof showing that **every §21.5 critical-action type** produces an append-only audit record (§23).
- **FR-018**: System MUST deliver a **localization-coverage** proof showing **zero missing pt-BR translation keys** across user-facing screens and correct BRL / Brazil date / `America/Sao_Paulo` formatting (§21.6).
- **FR-019**: System MUST deliver a **performance validation** against representative seed volumes showing the §21.2 budgets hold (trip list < 3s, trip detail < 2s, reports responsive for common filters), and the standard quality gate (lint, typecheck, tests, build) MUST pass before the PR.
- **FR-020**: UAT-discovered defects within MVP scope MUST be resolved in this slice; findings beyond MVP scope MUST be logged as deferred rather than silently expanding feature scope.

### Key Entities *(read models / queries — no new tables)*

- **SLA Performance read model**: a query/projection grouping trips by customer/lane/period and aggregating `trips.sla_status`/`trips.sla_reasons` into on-time pickup %, on-time arrival %, and on-track/at-risk/late/breached counts. Source: 007 SLA state. No new storage.
- **Exception Analytics read model**: a projection over `exceptions` + `reason_codes` grouping by customer/lane/period, reason-code category, and severity, with open/resolved counts and average resolution time. Source: 007. No new storage.
- **Billing Readiness read model**: a projection over the 003 `billingStatus` projection + 008 `billing_items`/`document_checks` signal grouping by customer/period into phase counts, completed-missing-documents count, and %-ready-within-24h. Source: 003/008. No new storage.
- **Audit History view model**: a filtered read over the append-only `audit_logs` + `trip_events` for the §21.5 record types, by entity/actor/action/date range. Source: 001/003. No new storage.
- **MVP Acceptance Traceability matrix**: a deliverable artifact (not a runtime entity) mapping each §23 criterion → PRD requirement IDs → owning slice → verification method → pass/blocked status. See "MVP Acceptance Traceability" below.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A business user can answer "what was on-time pickup/arrival performance for customer X on lane Y last month?" entirely within the system, with no export to an external spreadsheet, in under 30 seconds.
- **SC-002**: Each report (SLA, exception, billing readiness) loads within **3 seconds** for a single customer-month at representative daily operating volumes.
- **SC-003**: **100%** of §23 MVP acceptance criteria are validated end to end and mapped to PRD requirement IDs in the traceability matrix, each with a recorded **pass** or explicit **blocked-on-business-input** status.
- **SC-004**: **100%** of BFF operational and billing **mutation** endpoints reject unauthorized roles (403) and permit authorized roles, as proven by the permission-coverage matrix.
- **SC-005**: **100%** of §21.5 critical-action types are shown to produce an append-only audit record verifiable in the audit view.
- **SC-006**: **100%** of user-facing screens render in pt-BR with **zero** missing translation keys, and all currency/date/time values render in BRL / Brazil format / `America/Sao_Paulo`.
- **SC-007**: Reports reflect new operational data within one polling interval, so no external spreadsheet must be manually refreshed to review current performance.
- **SC-008**: For the SLA, exception, and billing-readiness review tasks, the number of out-of-system spreadsheet edits required drops to **zero** (the §22 Phase 5 / §9.3 adoption goal: the system, not the spreadsheet, is the system of record).

## MVP Acceptance Traceability

Each §23 acceptance criterion maps to its PRD requirement IDs and the slice that owns the capability; slice 009 **verifies** each end to end (and reports **blocked** where a §29 business input is outstanding). This matrix is the FR-015 deliverable.

| # | §23 Acceptance criterion | PRD requirement IDs | Owning slice | 009 verification |
|---|---|---|---|---|
| 1 | Shopee/DHL/ML trips import via configured templates | INT-001..007, CUST-003, LANE-005 | 004 | End-to-end import run; *blocked* on §29 Input #1 (real files) |
| 2 | Invalid rows flagged with clear messages | INT-004, INT-005 | 004 | Validation-report check |
| 3 | Duplicate trips detected | INT-006, §19.1 | 004 | Duplicate-detection check |
| 4 | Operations can view and filter all trips | TRIP-001..005, REP-001/005 | 005 | Board filter + export check |
| 5 | Dispatch can assign resources and confirm trips | DISP-001..009 | 006 | Assignment + confirmation check |
| 6 | Control tower can update statuses and log exceptions | EVT-001..005, EXC-001..006 | 007 | Status + exception check |
| 7 | Trip timeline shows planned and actual events | EVT-001..005, TRIP-006/007 | 003/007 | Timeline check |
| 8 | Users can upload required proof documents | DOC-001..006 | 008 | Upload + checklist check |
| 9 | Completed trips can be marked billing pending | §19.3, §11.6, BILL-001 | 008 | Completion → billing-pending check |
| 10 | Finance can validate and export billing-ready trips | §19.4, BILL-002..008 | 008 | Billing-ready + export check; *blocked* on §29 Inputs #3/#4/#5 |
| 11 | Dashboards show active, at-risk, SLA performance, exceptions, billing readiness | SLA-003/004/005, REP-001..004 | 005/007/**009** | **This slice**: SLA/exception/billing-readiness reports; *SLA blocked* on §29 Input #2 |
| 12 | Permission rules prevent unauthorized operational and billing changes | §18, all `*_trips`/billing keys | 001 + all | **This slice**: permission-coverage matrix (FR-016) |
| 13 | Critical changes appear in audit history | §21.5, AUTH audit foundation | 001 + all | **This slice**: audit-completeness proof + audit view (FR-013/014/017) |

## Assumptions

- The reports reuse the **005 read-model layer and conventions** (`packages/db/src/.../*-read.ts`, the `queryDashboardMetrics`/`queryTripBoard` pattern, the `DEFAULT_TRIP_VIEWS` view registry, and the `apps/web/lib/nav.ts` navigation registry); the physical decomposition (a dedicated `reporting` module vs extending existing read modules, plus any supporting index) is a `/speckit-plan` decision.
- SLA reporting reads **007's** stored `trips.sla_status`/`trips.sla_reasons` and reflects whatever `customer_sla_rules` are in force (or `DEFAULT_SLA_POLICY`); exception reporting reads **007's** `exceptions`/`reason_codes`; billing-readiness reporting reads **003's** `billingStatus` projection + **008's** `billing_items`/`document_checks` signal. None of these are redefined.
- **Period** is the calendar month in `America/Sao_Paulo`, reusing 008's billing-period (month of completion) and 005's BRT day-range conventions; timestamps are stored UTC.
- **No new permission key**: reports use `view_all_trips`; the dedicated audit view uses `view_audit_log` (Admin); SLA-rule / document-requirement administration stays on `manage_commercial_data`. Broadening which roles hold `view_audit_log` (e.g., to Finance for billing audit) is an admin/role-grant decision, not new code in this slice.
- **No new worker job / table / enum / package / runtime dependency**: reporting is synchronous read-only projection; freshness is polling.
- Aggregate-report CSV export, and the revenue / carrier-performance / lane-performance / profitability reports listed in §15.11, are **out of MVP scope** (REP-006/007/008, Later); raw trip-list extraction remains **005's REP-005** (`exportTripRows`).
- The active feature directory was `specs/008-documents-billing-export`; this command creates `specs/009-reporting-audit-hardening` and updates `.specify/feature.json`. Feature PRs target `dev`, never `main` (Constitution / `docs/DELIVERY-WORKFLOW.md`).

## Blocked / Open for business sign-off *(gated business inputs — configurable defaults, sign-off blocked, never invented — Constitution II)*

- **Per-customer SLA rules (§29 Input #2)** gate **final SLA reporting sign-off**. Until supplied, the SLA report computes on `DEFAULT_SLA_POLICY` and renders a visible **provisional** indicator; SLA reporting sign-off is reported **blocked**. *(SLA-005, REP-002)*
- **Per-customer required proof documents (§29 Input #3)**, the **finance billing export format (§29 Input #4)**, and the **billing rules for tolls/waiting-time/penalties/cancellation (§29 Input #5)** gate **final billing-readiness reporting sign-off**. Until supplied, the billing-readiness report runs on the default checklist + manual values and renders a visible **provisional** indicator; billing-readiness reporting sign-off is reported **blocked**. *(REP-004)*
- These gates affect **sign-off only** — not buildability and **not MVP-acceptance pass/fail**: the slice ships and is fully testable on the documented defaults; each affected §23 criterion is recorded **pass-with-blocked-sign-off** (FR-015, release permitted), and each blocked sign-off is surfaced explicitly rather than presenting provisional figures as final.

## Out of Scope (Deferred / Future Enhancements)

- **Lane performance report** beyond what MVP acceptance requires (REP-006).
- **Carrier scorecard / carrier performance report** (REP-007, §15.11 line).
- **Profitability dashboard** and revenue-by-customer/lane reporting (REP-008, §15.11 line, §9.2 revenue metric).
- **Advanced BI / data-warehouse work**: materialized views, a separate reporting database, ETL pipelines, scheduled report generation, or a BI tool.
- **Aggregate-report export** to CSV/spreadsheet (raw trip-list export remains 005's REP-005).
- **Configurable alert thresholds and external notification channels** (SLA-006/007) — Later, per slice 007 boundary.
- Per-customer report customization or per-customer report code (customer variation stays config-driven over one report engine).
