# MVP Acceptance Traceability & Hardening Contract — 009

This is the slice's release-gate artifact (FR-015). It maps **every §23 MVP acceptance criterion** to its PRD requirement IDs, owning slice, and the **verification** performed in this slice, and defines the four **hardening proofs** (FR-016–FR-019). Per clarify Q1, a criterion whose only outstanding dependency is a §29 business input is **pass-with-blocked-sign-off** (verified on documented defaults; release permitted; sign-off tracked separately) — **not** an acceptance failure.

## A. §23 acceptance traceability matrix

| # | §23 criterion | PRD IDs | Owner | Verification (this slice) | Status rule |
|---|---|---|---|---|---|
| 1 | Shopee/DHL/ML import via configured templates | INT-001..007, CUST-003, LANE-005 | 004 | e2e import run on fixtures | pass; **blocked sign-off** on §29 #1 (real files) |
| 2 | Invalid rows flagged with clear messages | INT-004/005 | 004 | e2e validation-report assertion | pass |
| 3 | Duplicate trips detected | INT-006, §19.1 | 004 | e2e duplicate-detection assertion | pass |
| 4 | View and filter all trips | TRIP-001..005, REP-001/005 | 005 | e2e board filter + export | pass |
| 5 | Assign resources and confirm trips | DISP-001..009 | 006 | e2e assignment + confirmation | pass |
| 6 | Update statuses and log exceptions | EVT-001..005, EXC-001..006 | 007 | e2e status + exception | pass |
| 7 | Timeline shows planned and actual events | EVT-001..005, TRIP-006/007 | 003/007 | e2e timeline | pass |
| 8 | Upload required proof documents | DOC-001..006 | 008 | e2e upload + checklist | pass |
| 9 | Completed trips → billing pending | §19.3, §11.6, BILL-001 | 008 | e2e completion→billing_pending | pass |
| 10 | Validate and export billing-ready trips | §19.4, BILL-002..008 | 008 | e2e billing-ready + export | pass; **blocked sign-off** on §29 #3/#4/#5 |
| 11 | Dashboards: active, at-risk, **SLA performance, exceptions, billing readiness** | SLA-003/004/**005**, REP-001/**002/003/004** | 005/007/**009** | **This slice**: `reports.spec.ts` — SLA/exception/billing-readiness reports | pass; **blocked sign-off** (SLA) on §29 #2 |
| 12 | Permission rules prevent unauthorized changes | §18, all keys | 001 + all | **This slice**: `permission-coverage.spec.ts` (§B.1) | pass |
| 13 | Critical changes appear in audit history | §21.5 | 001 + all | **This slice**: `audit-completeness.spec.ts` (§B.2) + audit view | pass |

**Definition of Done (slice 009)**: all 13 rows `pass` (blocked-sign-off rows count as pass per clarify Q1); the four hardening proofs (§B) green; the CI gate (lint/typecheck/build/tests) passes (SPEC-SLICING 009 exit criterion).

### Verification status (009 close-out, 2026-06-01)

- **All 13 §23 rows: `pass`.** The three new reports (row 11) ship behind `view_all_trips` with the SLA + billing-readiness provisional banners; permission coverage (row 12) and audit completeness (row 13) are the new hardening suites below.
- **Blocked sign-offs are EXACTLY the §29-input rows** — and nothing else: SLA-reporting sign-off (§29 #2, row 11), billing-readiness-reporting / export / billing-rule sign-off (§29 #3/#4/#5, rows 10–11). Each is surfaced by a visible **provisional** banner and runs on documented defaults (`DEFAULT_SLA_POLICY` / default document checklist + manual values) — never invented (Constitution II). No non-§29 row is blocked.
- **Hardening proofs (§B) — all executed green (2026-06-01):**
  - **B.1 permission coverage** — `permission-coverage.spec.ts` **29/29** (one mutation row per key across 001–008; non-holder `403`, holder past the gate). Note: the matrix uses the actual `ROLE_PERMISSIONS` holders — `import_trips` is held by **admin + operations_manager only** (not dispatcher, despite the nav comment).
  - **B.2 audit completeness** — `audit-completeness.spec.ts` **2/2**: each major §21.5 action type writes an append-only `audit_logs` row (with actor); the `SET LOCAL ROLE` probe confirms UPDATE/DELETE on `audit_logs`/`trip_events` is denied (SQLSTATE 42501).
  - **B.3 localization** — `messages.test.ts` **green** (12 tests incl. the `Reports`/`AuditView` namespaces + reason-code-category / severity / billing-phase coverage); `ALL_AUDIT_ACTIONS`→flat-label invariant holds; zero dotted keys.
  - **B.4 performance** — **within budget** (table above), no `0008` migration.
  - Report read-model integration (`sla`/`exceptions`/`billing-readiness`/`audit-read`) — **13 tests green** vs the live DB; the report endpoints + screens (`reports-sla`/`reports-exceptions`/`reports-billing`) and the extended audit view (`audit`/`master-data-audit`) — **green** e2e. Full 009 e2e run: **46/46 passed** against a prod build (`next start`, `--workers=1`, after `db:seed:e2e`).

## B. Hardening proofs

### B.1 Permission coverage (FR-016 · §23 row 12)
`apps/web/e2e/permission-coverage.spec.ts` — for **every operational/billing mutation endpoint across 001–008**, a **holder → `2xx`** and a **non-holder → `403` + no state change**. Endpoint↔key list per [permission-matrix.md](./permission-matrix.md). **Pass = 100%** of mutation endpoints enforce their key (SC-004).

### B.2 Audit completeness (FR-017 · §23 row 13)
`apps/web/e2e/audit-completeness.spec.ts` — trigger one of each §21.5 action type and assert an **append-only `audit_logs` row** is written with action + actor (+ before/after where applicable):
import confirmation · plan/execution edit · assignment change · status transition · exception create/resolve · **document verification** · **billing change** · **export-batch creation** · permission/user change. **Pass = 100%** of §21.5 action types covered (SC-005). Also asserts append-only enforcement holds (REVOKE on `audit_logs`/`trip_events`, per MEMORY: test via `SET LOCAL ROLE`).

### B.3 Localization coverage (FR-018 · §21.6)
EXTEND `apps/web/lib/messages.test.ts` — the new `Reports`/`AuditView` namespaces present and **dot-free** (next-intl INVALID_KEY guard, per MEMORY); the `ALL_AUDIT_ACTIONS` → flat `AuditActions[key]` invariant still holds (covers any new action labels); a render smoke check that no in-scope screen shows a raw missing-key token; currency BRL + dates/time `America/Sao_Paulo` (Luxon). **Pass = zero missing keys** (SC-006).

### B.4 Performance validation (FR-019 · §21.2)
Recorded procedure (quickstart §6): against a seeded representative volume (a customer with a month of trips/exceptions/billing items), measure each report and the trip list/detail vs the §21.2 budgets (reports & trip list **< 3 s**, trip detail **< 2 s**; SC-002). If a report misses budget, add the contingent index migration `0008` (research R6) and re-measure. Record results in the PR.

**Result (2026-06-01, local dev DB, representative customer-month: 400 trips · 1 440 trip_events · 120 exceptions · 240 billing items, all filtered to the seeded customer):**

| Surface | Budget | Measured |
|---|---|---|
| `querySlaReport` (`GET /api/reports/sla`) | < 3 000 ms | **108 ms** |
| `queryExceptionReport` (`GET /api/reports/exceptions`) | < 3 000 ms | **75 ms** |
| `queryBillingReadinessReport` (`GET /api/reports/billing-readiness`) | < 3 000 ms | **47 ms** |
| `queryTripBoard` (trip list) | < 3 000 ms | **32 ms** |
| `getTripDetailView` (trip detail) | < 2 000 ms | **84 ms** |
| `queryAuditLog` (`GET /api/admin/audit-logs`) | < 3 000 ms | **6 ms** |

**All surfaces are well within budget on existing indexes — the contingent `0008` index migration is NOT added (research R6 / YAGNI).** Measured with a throwaway harness seeding/cleaning the customer-month against the existing `trips_customer_idx` / `trips_pickup_start_idx` / `trips_status_idx`, the fully-indexed `exceptions`, `billing_items_customer_period_idx`, and `audit_logs_{entity,actor,created}_idx`.

## C. Gated business inputs (blocked sign-offs — Constitution II / clarify Q1)

| Input (§29) | Affects | Default used | Sign-off |
|---|---|---|---|
| #2 Per-customer SLA rules | SLA report (§23 row 11) | `DEFAULT_SLA_POLICY`; report shows provisional banner | **SLA reporting sign-off BLOCKED** |
| #3 Per-customer proof documents | Billing-readiness report (row 11) | `DEFAULT_DOCUMENT_CHECKLIST` | **Billing-readiness reporting sign-off BLOCKED** |
| #4 Finance export format | Billing-readiness/export (row 10) | labeled default columns (008) | **Export sign-off BLOCKED** |
| #5 Per-customer billing rules | Billing-readiness report (row 11) | manual values (008) | **Billing-rule sign-off BLOCKED** |

Each blocked sign-off is surfaced (provisional banner) and recorded here — never presented as final, never invented.
