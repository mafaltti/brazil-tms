# Quickstart — 009 Reporting, Audit Views, Hardening, and MVP Acceptance

How to run and verify this slice. It is **read-only**: **no migration, no seed, no worker change** is required — it runs against the existing dev DB and the slices 001–008 stack.

## 1. Prerequisites (unchanged from prior slices)

- Local stack up: self-hosted Supabase (Postgres/Auth/Storage), the Next.js app, the worker, Caddy (`infra/`), per the slice-008 quickstart / MEMORY `supabase_local_stack`.
- `DATABASE_URL` exported for the web Vitest integration tests (MEMORY `web_vitest_run_command`).
- Data to look at: any customer with a month of trips that have SLA state, exceptions, and billing items (use the existing 005/007/008 seeds; no new seed is added).

## 2. Run

```bash
pnpm install          # no new deps — lockfile unchanged
pnpm dev              # app + worker (worker unchanged by this slice)
```

Open the app → the sidebar now shows **Relatórios** (Reports) for any role with `view_all_trips`. **Administração → Auditoria** (audit) gains actor + date-range filters for Admin (`view_audit_log`).

> No `pnpm db:migrate` step — this slice adds no migration in the default build. (If the performance validation in §6 forces the contingent index migration `0008`, run `pnpm db:migrate` then.)

## 3. Verify US1 — SLA performance report (P1)

1. As a `view_all_trips` user, open **Relatórios → SLA**, filter to a customer / lane / last month.
2. Assert on-time pickup %, on-time arrival %, and on-track/at-risk/late/breached counts match the seeded outcomes, grouped by customer (then switch to lane).
3. Cross-check: the same on-time numbers on overlapping data agree with the Home dashboard (single source of truth — `onTimeExpr`).
4. Pick a customer with **no** `customer_sla_rules` row → assert the **provisional banner** ("pendente de regras de SLA do cliente") shows.
5. As a user without `view_all_trips` (token stripped) → `/api/reports/sla` returns `403`.

## 4. Verify US2 — exception report · US3 — billing readiness (P2)

- **Exceptions**: open **Relatórios → Exceções** for a customer/month → assert volume by reason-code category + severity, open vs resolved counts, and average resolution time match the seed.
- **Billing readiness**: open **Relatórios → Prontidão de cobrança** → assert phase counts (billing_pending/ready/billed/disputed via the 003 projection), the completed-missing-documents count, and **% ready within 24h** (completion→`billing_ready` ≤ 24h). Assert the **provisional banner** appears for a customer on default document/billing rules.

## 5. Verify US4 — audit history view (P3)

1. As **Admin** (`view_audit_log`), open **Administração → Auditoria**.
2. Trigger a critical change in another tab (e.g., verify a document, update a billing item, run an export) → filter the audit view by **actor**, **action**, and a **date range** → assert the row appears with actor name, action, timestamp, and before/after.
3. As a **non-Admin** → `/api/admin/audit-logs` returns `403`; the embedded per-trip timeline on Trip Detail still renders under `view_all_trips`.

## 6. Verify US5 — hardening + MVP acceptance (P1)

Run the hardening suites and record the traceability:

```bash
# unit / integration (web) — MEMORY: --project web + DATABASE_URL
pnpm exec vitest run --project web apps/web/lib/messages.test.ts
pnpm exec vitest run --project web apps/web/lib/trips/reporting.test.ts

# e2e — MEMORY: prod build, --workers=1, db:seed:e2e first
pnpm --filter @brazil-tms/web db:seed:e2e
pnpm --filter @brazil-tms/web test:e2e -- reports.spec.ts audit.spec.ts permission-coverage.spec.ts audit-completeness.spec.ts
```

- **Permission coverage** (`permission-coverage.spec.ts`): every operational/billing mutation across 001–008 → holder `2xx`, non-holder `403`.
- **Audit completeness** (`audit-completeness.spec.ts`): each §21.5 action type writes an append-only `audit_logs` row.
- **Localization** (`messages.test.ts`): no dotted keys; `Reports`/`AuditView` namespaces present; all audit actions have flat labels.
- **Performance**: with a seeded customer-month, measure each report + trip list/detail vs §21.2 (reports & list < 3 s, detail < 2 s). Record numbers in the PR. If a report misses budget → add migration `0008` (research R6) and re-measure.
- **Traceability**: confirm every §23 row in [contracts/acceptance-and-hardening.md](./contracts/acceptance-and-hardening.md) is `pass` (blocked-sign-off rows count as pass, clarify Q1).

## 7. Quality gate (the slice's exit criterion)

```bash
pnpm lint && pnpm typecheck && pnpm build && pnpm test
```

All green is part of the deliverable (SPEC-SLICING 009 exit criterion). Then open the PR to **`dev`** (never `main`).

## 8. What this slice does NOT touch

No new table/enum/migration (default build), no new permission key, no new package, no new worker job, no new runtime dependency (no charting library), no Realtime. Revenue/carrier/lane/profitability reports, advanced BI, and aggregate-report export are out of scope (Future Enhancements).
