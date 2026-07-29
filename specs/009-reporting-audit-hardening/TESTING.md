# Feature 009 — Self-test guide (Reporting, Audit Views, Hardening & MVP Acceptance)

How to stand up the local stack and exercise the **final MVP slice**: the **Reports** screen
(`Relatórios`) with the three MVP-acceptance reports — **SLA performance**, **exception volume &
delay reasons**, **billing readiness** — the **extended audit-history view**, and the cross-cutting
**hardening** proofs (permission coverage, audit completeness, localization, performance). Host:
Windows + PowerShell. Prereqs: Docker Desktop running, Node 20+/pnpm, `pnpm install` already done.
This slice is **read-only over the data slices 003–008 produce** and reuses the control-tower shell
(005), the SLA state (007), and the documents/billing model (008).

What's different from earlier slices:

- **Read-only, adds nothing durable.** NO new table, enum, **migration**, permission key, worker job,
  or runtime dependency. `db:migrate` still stops at **`0007`** — 009 adds no migration (a contingent
  `0008` index was measured and **not** needed; see §4 Performance).
- **No worker is required for 009.** The three reports are **synchronous read-model projections** in
  the BFF (no queue, no job). You only need the 007/008 worker if you want to keep the reports'
  **inputs** fresh — the SLA report reads the stored `trips.sla_status` that 007's `sla.sweep`
  maintains, and the dashboard's "completed-missing-documents" signal comes from 008's
  `documents.checks`. The reports, the audit view, and everything in this guide work **with the app
  alone**.
- **No new permission key.** Reports reuse **`view_all_trips`** (all seven internal roles, like the 005
  dashboard); the dedicated audit view reuses **`view_audit_log`** (**Admin only**); SLA-rule /
  document-requirement admin stays on `manage_commercial_data`.
- **Freshness is polling** (TanStack Query, ~60 s) — no Realtime.
- **Reports are tables + summary cards** — **no charting library** (charts are Later).

> ⚠️ **The single most important thing to know before you look at a report.** The **default period is
> the _last completed calendar month_** in `America/Sao_Paulo`. On a June day the default report shows
> **May**. So a freshly-seeded or just-created trip (dated *this* month, or in some other month) will
> make the **default report look empty** — that is correct behavior, not a bug. **Use the `De` / `Até`
> date filter** to point the report at the month your data actually lives in. See §5.1.

> Your local `.env` files already exist (gitignored): `infra/supabase/.env`, `apps/web/.env.local`,
> `packages/db/.env`, `workers/.env`. **009 adds no env var.**

## 1. Bring it up

```powershell
docker compose -f infra/supabase/docker-compose.yml up -d   # Postgres + GoTrue + gateway + Mailpit
curl http://localhost:8000/auth/v1/health                   # -> HTTP 200 {"name":"GoTrue",...}

pnpm --filter @brazil-tms/db db:migrate                     # applies through 0007 — 009 adds NO migration
pnpm --filter @brazil-tms/db db:seed:e2e                    # role accounts (table in §2)
pnpm --filter @brazil-tms/db db:seed:master-data           # customer "Shopee (Demo)" + lanes + locations
pnpm --filter @brazil-tms/db db:seed:trip-domain           # sample trips across statuses (+ their trip_events)
pnpm --filter @brazil-tms/db db:seed:reason-codes          # the 12 §13.8 reason-code categories (007) — exception report
pnpm --filter @brazil-tms/db db:seed:sla-rules             # OPTIONAL: a per-customer SLA rule (clears the SLA provisional banner)
pnpm --filter @brazil-tms/db db:seed:document-types        # proof types (008) — needed to define a doc checklist (clears billing banner)
pnpm --filter @brazil-tms/db db:seed:rates                 # OPTIONAL: a base rate so billing items price automatically
```

> `db:migrate` runs migrations 001→**0007** only. **009 introduces no new schema** — every report is a
> projection over existing tables (`trips`, `trip_events`, `exceptions`, `reason_codes`,
> `customer_sla_rules`, `billing_items`, `audit_logs`). If you skipped them in an earlier slice, the
> `reason-codes` / `document-types` seeds are what make the exception + billing-readiness reports
> meaningful.

**Run the app** (always). The worker is **optional** for 009:

```powershell
# Terminal A — app (BFF + the Reports screen + the extended audit view) on http://localhost:3000
pnpm --filter @brazil-tms/web dev

# Terminal B — OPTIONAL. Only to keep the reports' INPUTS fresh (007 SLA states + 008 doc/billing alerts).
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
pnpm --filter @brazil-tms/workers start
```

- Host port 5432 taken? `SUPABASE_DB_PORT=5433` is already set in `infra/supabase/.env`.

## 2. Test accounts (from `db:seed:e2e`)

009 adds **no permission key**. Reports are gated by **`view_all_trips`** (all seven internal roles
hold it); the dedicated audit view by **`view_audit_log`** (**Admin only**); SLA-rule / document-
requirement admin by **`manage_commercial_data`** (used in §5 to clear the provisional banners).

| Email | Password | Role | Reports (`view_all_trips`) | Audit view (`view_audit_log`) | SLA-rule / doc-req admin (`manage_commercial_data`) |
|---|---|---|:--:|:--:|:--:|
| admin@braziltransports.com.br | `ChangeMe!Admin123` | Admin | ✅ | ✅ | ✅ |
| opsmanager@braziltransports.com.br | `ChangeMe!Ops123` | Operations Manager | ✅ | ❌ | ✅ |
| finance@braziltransports.com.br | `ChangeMe!Finance123` | Finance | ✅ | ❌ | ❌ |
| dispatcher@braziltransports.com.br | `ChangeMe!Dispatcher123` | Dispatcher | ✅ | ❌ | ❌ |
| fleetcoord@braziltransports.com.br | `ChangeMe!Fleet123` | Fleet Coordinator | ✅ | ❌ | ❌ |

> Every seeded role can open **Relatórios** (it mirrors the 005 dashboard's `view_all_trips`). Only
> **Admin** can open **Administração → Auditoria**; the other roles are redirected to `/` by the page
> guard and get **403** from `GET /api/admin/audit-logs`. The **per-trip embedded audit timeline** on
> Trip Detail is unchanged and stays on `view_all_trips` (so non-admins still see a trip's own history).
>
> All seven internal roles hold `view_all_trips`, so a report endpoint has **no seeded non-holder** —
> its negative case is `401` (no session). The permission-coverage suite (§4) exercises real
> non-holders against the **mutation** keys instead.

## 3. What the reports read (there is no 009-specific seed)

The reports are projections — they show exactly what slices 003–008 have produced. Inputs:

- **SLA performance** ← `trips.sla_status`/`sla_reasons` (007) for the state counts + `trip_events`
  (`at_origin`/`at_destination` arrivals vs the planned windows) for the on-time %s, via the **shared
  `onTimeExpr`** (the *same* predicate the Home dashboard uses); `customer_sla_rules` existence drives
  the **provisional** flag.
- **Exception volume / delay reasons** ← `exceptions` + `reason_codes` (007), joined to
  `trips`→`customers`/`lanes`.
- **Billing readiness** ← `billing_items.billing_period` (008) + the **`billingStatus(current_status)`**
  projection (003) + `trip_events` (the `completed`→`billing_ready` gap for "% ready within 24h") + the
  008 missing-proof predicate; `document_requirements` existence drives the **provisional** flag.
- **Audit view** ← the append-only `audit_logs` + a `users` join for the actor name.

> **Provisional/blocked sign-offs (§29, surfaced not invented).** A customer with **no**
> `customer_sla_rules` → the SLA report runs on `DEFAULT_SLA_POLICY` and shows a **"Provisório —
> pendente de regras de SLA do cliente"** banner. A customer with **no** `document_requirements` → the
> billing-readiness report shows **"Provisório — pendente de regras de cobrança/documentos"**. Run
> `db:seed:sla-rules` / define a checklist in `/admin/document-requirements` to clear them (§5.1, §5.3).

## 4. Automated tests

```powershell
pnpm lint ; pnpm typecheck ; pnpm build           # static gate (route exports, types, build)

# Unit only (no DB): pure period helpers + both query schemas + the localization guard. Integration SKIPs here.
pnpm test

# Integration (DB-backed): the report read models + the extended audit read. They un-skip ONLY when
# DATABASE_URL is set, and share the one dev DB — run serially. (Per MEMORY: --project web + DATABASE_URL.)
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
pnpm exec vitest run --project web --no-file-parallelism `
  apps/web/lib/reporting/sla.test.ts apps/web/lib/reporting/exceptions.test.ts `
  apps/web/lib/reporting/billing-readiness.test.ts apps/web/lib/audit/audit-read.test.ts

# End-to-end (app running; reset accounts first — role-change specs elsewhere pollute them):
pnpm --filter @brazil-tms/db db:seed:e2e
$env:PLAYWRIGHT_BASE_URL='http://localhost:3000'
pnpm --filter @brazil-tms/web exec playwright test `
  e2e/reports-sla.spec.ts e2e/reports-exceptions.spec.ts e2e/reports-billing.spec.ts `
  e2e/audit.spec.ts e2e/master-data-audit.spec.ts `
  e2e/permission-coverage.spec.ts e2e/audit-completeness.spec.ts --workers=1
```

> Why `pnpm test` shows tests "skipped": every DB-backed suite is guarded by
> `describe.skipIf(!process.env.DATABASE_URL)`, so the default run stays green without a database. The
> **pure** suites (`domain/reporting.test.ts`, `messages.test.ts`) always run. Run e2e against a **prod
> build** with `--workers=1`; a stale `next dev` can hold broken HMR state and cause false 500s.

The 009 suites and what they cover:

| Suite | DB? | Covers |
|---|:--:|---|
| `packages/shared/src/domain/reporting.test.ts` | no | `defaultReportPeriod` = last completed month (BRT, DST-safe + year rollover), `customReportPeriod` (`to` inclusive), `billingPeriodMonths`, `reportFilterSchema`, `auditLogQuerySchema` (date-only `from`/`to`) |
| `apps/web/lib/messages.test.ts` | no | no dotted keys; `Reports`/`AuditView` namespaces present; reason-code-category / severity / billing-phase label coverage; `ALL_AUDIT_ACTIONS`→flat-label invariant |
| `apps/web/lib/reporting/sla.test.ts` | yes | `querySlaReport`: on-time %s via `onTimeExpr`, stored `sla_status` counts, **`settled`** for closed (NULL-state) trips with `onTrack+atRisk+late+breached+settled = total`, customer **and** lane grouping, provisional toggle on a `customer_sla_rules` row |
| `apps/web/lib/reporting/exceptions.test.ts` | yes | `queryExceptionReport`: total/open/resolved + avg resolution minutes, breakdown by `reason_codes.category` + severity, customer grouping |
| `apps/web/lib/reporting/billing-readiness.test.ts` | yes | `queryBillingReadinessReport`: phase counts via `billingStatus`, completed-missing-documents, **% ready within 24h** (completion→`billing_ready` gap), provisional toggle on a `document_requirements` row |
| `apps/web/lib/audit/audit-read.test.ts` | yes | `queryAuditLog`: `actorUserId`/`from`/`to`/`limit`/`offset` filters, **São Paulo day bounds** (`to` inclusive), `actorName` join, `{ items, total }` |
| `e2e/reports-{sla,exceptions,billing}.spec.ts` | — | each endpoint: no-session `401`, `view_all_trips` holder `200` + report shape; the tab renders; SLA flags a default-policy customer `provisional` |
| `e2e/audit.spec.ts` (extended) + `e2e/master-data-audit.spec.ts` | — | actor + date-range filters; the `actorName` join; non-admin `403`; `{ items, total }` shape |
| `e2e/permission-coverage.spec.ts` | — | **29** mutation endpoints across 001–008 — non-holder `403`, holder past the gate (FR-016 / SC-004) |
| `e2e/audit-completeness.spec.ts` | — | each major §21.5 action writes an append-only `audit_logs` row + the `SET LOCAL ROLE` append-only proof (SQLSTATE `42501`) |

**Performance (FR-019 / §21.2), recorded.** Measured against a seeded representative customer-month
(400 trips · 1 440 events · 120 exceptions · 240 billing items): SLA **108 ms**, exceptions **75 ms**,
billing-readiness **47 ms**, trip list **32 ms**, trip detail **84 ms**, audit view **6 ms** — all far
under the budget (reports & list < 3 s, detail < 2 s), so the contingent `0008` index migration is
**not** added. The full matrix is in [contracts/acceptance-and-hardening.md](./contracts/acceptance-and-hardening.md).

> HTTP-status + authz assertions (401/403) live in the Playwright `e2e/` specs, **not** in
> `route.test.ts` (web Vitest only includes `lib/**`).

## 5. Manual walkthrough (maps to the spec's user stories US1–US5)

Open **http://localhost:3000**, sign in. UI is **pt-BR**. Everything here works **with the app alone**.
The sidebar now shows **Relatórios**; **Administração → Auditoria** is Admin-only.

### 5.0 Authz
- Logged out: `GET /api/reports/sla` (and `/exceptions`, `/billing-readiness`) → **401**; `/reports` →
  redirect to `/login`.
- As **finance@** (or any non-admin): `/reports` opens fine (all roles hold `view_all_trips`), but
  **Administração → Auditoria** redirects to `/` and `GET /api/admin/audit-logs` → **403**.
- As **admin@**: the audit view opens. The per-trip timeline on **Trip Detail** renders for every
  `view_all_trips` role regardless (it's the embedded 005 timeline, not the dedicated view).

### 5.1 US1 — SLA performance report
1. As any role, open **Relatórios → SLA**. **Mind the period** (the ⚠️ note up top): the default is the
   **last completed month**. If it's empty, set **`De` / `Até`** to the month your seed/created trips
   are in (the label updates, e.g. `01/05/2026 – 31/05/2026`).
2. Read the **summary cards**: **on-time pickup %**, **on-time arrival %**, **breached** count. Then the
   per-group **table**: total, the two on-time %s, and **No prazo / Em risco / Atrasado / Violado /
   **Sem estado**** counts.
3. **Why "Sem estado" matters (the closed-trip case):** 007 **clears** `trips.sla_status` once a trip
   leaves the active set, so **completed/billed trips carry no live risk state** and land in **Sem
   estado** — they are *not* silently dropped. For a historical (mostly-closed) month you'll typically
   see the risk states near zero and **Sem estado ≈ total**; the **period performance is the on-time
   %s** (the caption under the cards says exactly this). The five buckets always reconcile:
   `No prazo + Em risco + Atrasado + Violado + Sem estado = Total`.
4. **Single source of truth:** the on-time %s use the same `onTimeExpr` as the **Home dashboard** (`/`).
   On overlapping data the numbers agree — by construction, the report can't diverge from the dashboard.
5. **Group by** customer ↔ lane (the **Agrupar por** select) and watch the rows regroup without leaving
   the page or exporting.
6. **Provisional banner:** pick a customer with **no** `customer_sla_rules` → the amber **"Provisório —
   pendente de regras de SLA do cliente"** banner shows. Run `db:seed:sla-rules` (or add a rule under
   `/sla-rules`) for that customer and reload → the banner clears.

### 5.2 US2 — exception volume & delay reasons
1. Open **Relatórios → Exceções** for a customer/period. Summary cards: **total**, **abertas**
   (open + monitoring), **resolvidas**, **tempo médio de resolução** (avg `resolved_at − opened_at`).
2. The two breakdown tables: **Por categoria** (the 12 §13.8 reason-code categories, e.g. *Atraso*,
   *Acidente*) and **Por severidade** (*Baixa/Média/Alta*), plus a per-customer/lane table.
3. Period membership is by the exception's **`opened_at`** (not pickup date) — an exception opened in
   May on a June-pickup trip belongs to **May's** exception volume. If empty, create a few exceptions
   on the Exception screen / Trip Detail (007) and set the period to this month.

### 5.3 US3 — billing readiness
1. Open **Relatórios → Prontidão de cobrança** (customer-only grouping; the lane picker is hidden here).
   Cards: the four **phase counts** (Pendente / Pronto / Faturado / Em disputa, via the
   `billingStatus(current_status)` projection), **Concluídas sem documentos**, and **% prontas em 24h**
   (share of completed trips whose `completed`→`billing_ready` gap ≤ 24 h).
2. Period membership is by **`billing_items.billing_period`** (008's month-of-completion). To populate
   it, complete some trips in 008 (which creates billing items dated to the completion month) and set
   the period accordingly.
3. **Provisional banner:** a customer with **no** `document_requirements` shows **"Provisório —
   pendente de regras de cobrança/documentos"**. Define a checklist under
   **`/admin/document-requirements`** (as admin@/opsmanager@) and reload → it clears.

### 5.4 US4 — the extended audit-history view
1. As **admin@**, open **Administração → Auditoria** (`/admin/audit`). Generate some audited actions
   first if needed (e.g. create/disable a user under `/admin/users`, verify a document, run an export).
2. **Entity-type presets** (the §21.5 record types): **Todas / Viagens / Exceções / Documentos /
   Cobrança / Exportações / Usuários** — each narrows `entity_type`.
3. **Filters:** **Ação** (a dropdown of every audit action, pt-BR-labelled), **ID da entidade** (a
   specific record UUID), **ID do responsável** (actor UUID), and a **`De` / `Até` date range**. The
   date range uses **São Paulo day bounds with `Até` inclusive** — selecting today's date as `Até`
   **includes** today's records (the earlier UTC-midnight off-by-one is fixed). Each row shows the
   **actor name** (joined from `users`), the action label, entity, and the before/after snapshot.
4. **Pagination:** the footer shows **"Mostrando X–Y de N"** with **Anterior / Próxima** — true
   `offset` paging over the full result set (no 200-row cap; you can browse older records).
5. As a **non-admin**: the page redirects to `/` and the API returns **403** — but the **per-trip
   timeline** on any Trip Detail still renders (it's `view_all_trips`).

### 5.5 US5 — hardening & MVP acceptance
1. Run the four hardening suites from §4 (permission-coverage, audit-completeness, the localization
   guard, and the recorded performance numbers). All four are green.
2. Read the **§23 traceability matrix** in
   [contracts/acceptance-and-hardening.md](./contracts/acceptance-and-hardening.md): every acceptance
   row is **pass**, and the only **blocked sign-offs** are the §29-input rows (SLA reporting on §29 #2;
   billing-readiness on §29 #3/#4/#5) — each surfaced by a provisional banner, never invented.

## 6. Tear down

```powershell
docker compose -f infra/supabase/docker-compose.yml down -v   # stop + wipe the DB volume
# stop the app (Ctrl+C in Terminal A) and, if you started it, the worker (Terminal B)
```

> `down -v` wipes the database; re-run the §1 migrate + seeds after a fresh bring-up. 009 is read-only —
> it stores nothing of its own; the reports only ever reflect what 003–008 put in the database. Real
> per-customer SLA rules, proof-document checklists, the finance export format, and per-customer billing
> rules remain **BLOCKED** on customer files (PRD §29); this guide exercises the reports with
> documented-default scaffolding, and the affected sign-offs surface as **provisional** banners.
