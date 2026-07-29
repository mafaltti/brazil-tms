# Quickstart: Documents, Completion, Billing Readiness, Rates, and Export (008)

**Feature**: 008-documents-billing-export | **Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Research**: [research.md](./research.md) · **Data model**: [data-model.md](./data-model.md) · **Contracts**: [contracts/](./contracts/)

This slice is the **proof-and-money close-out**: attach **proof documents** (POD, CT-e/MDF-e refs, gate receipts) to a trip, **verify** them, **gate Completed and Billing Ready** on the per-customer required-document checklist + pricing + dispute rules (transitions on 003's status machine — billing status is the `billingStatus(current_status)` projection), maintain **simple rates** + a typed **billable breakdown**, and **export** billing-ready trips to CSV/spreadsheet with durable **export-batch history**. It reuses 001 (auth/audit/i18n/Storage-client) + 002 (customers/lanes/`manage_commercial_data`) + 003 (`transitionTripStatus` / `billingStatus` projection / append-only logs) + 004 (import-batch + worker/pg-boss + `packages/db/src/storage.ts`) + 005 (board/detail/dashboard + view registry) + 007 (the in-app `alerts` store). It adds **seven tables** (`document_types`, `documents`, `document_requirements`, `rates`, `billing_items`, `billing_adjustments`, `export_batches`), **three enums** (`document_verification_status`, `export_batch_status`, `billing_adjustment_type`), two **Storage buckets** (`documents`, `billing-exports`), and **two worker jobs** (on-demand `billing.export` + scheduled `documents.checks`). **No new permission key, no new package, no new worker process, no new runtime dependency, no `trips` ALTER** — it first-enforces the six 008 keys and reuses `manage_commercial_data`.

## Prerequisites (same stack as 001–007)

```powershell
pnpm install
docker compose -f infra/supabase/docker-compose.yml up -d   # Supabase (Postgres/Auth/Storage), Caddy gateway
curl http://localhost:54321/auth/v1/health                  # GoTrue healthy
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
pnpm db:migrate                                             # 001–007 migrations (through 0006_*)
pnpm db:seed                                               # admin account
pnpm db:seed:master-data                                   # customers / locations / lanes
pnpm db:seed:trip-domain                                   # sample trips incl. some at `unloaded` (completion-ready)
```

## Apply this feature's migration

008 adds three enums + seven tables (no `trips` ALTER). After editing the new schema files (`packages/db/schema/{document-types,documents,document-requirements,rates,billing-items,billing-adjustments,export-batches}.ts` + the three enums in `enums.ts`) and re-exporting them from `packages/db/schema/index.ts`:

```powershell
pnpm --filter "@brazil-tms/db" db:generate                # emit 0007_*.sql (CREATE TYPE x3 + CREATE TABLE x7)
# Hand-verify the generated 0007_*.sql before applying:
#   (a) CREATE TYPE x3 (document_verification_status, export_batch_status, billing_adjustment_type) ordered before first use
#   (b) documents_file_or_waiver_ck CHECK (file_storage_key IS NOT NULL OR waived_at IS NOT NULL)
#   (c) billing_items_trip_uq UNIQUE (trip_id) — one billing item per trip
#   (d) export_batches created BEFORE billing_items (so billing_items.export_batch_id FK resolves); the FK + export_batches_format_ck CHECK ('csv','xlsx')
#   (e) NO ALTER on trips (billing status is the billingStatus projection — FR-011)
pnpm --filter "@brazil-tms/db" db:migrate                 # apply 0007_*.sql
```

**No `REVOKE` step** for the seven tables — they **mutate** (verification, billing values/adjustments, export-batch status, soft-delete) like `import_batches`/`trip_assignments`, so they are NOT append-only. `trip_events`/`audit_logs` **keep their existing REVOKE** (008 only INSERTs status-change events via the reused `transitionTripStatus`). `export_batch_status` is a pgEnum mirroring `import_batch_status`; `export_batches.format` and `billing_items.dispute_status` are CHECK text; `document_types` is a config table (not an enum), so new proof types need no `CREATE TYPE` migration.

## Seed document types (+ optional sample rate) + provision Storage buckets

```powershell
pnpm --filter "@brazil-tms/db" db:seed:document-types       # labeled-scaffolding types: pod, cte, mdfe, gate_receipt, portal_ref (pt-BR labels)
pnpm --filter "@brazil-tms/db" db:seed:rates                # OPTIONAL: one sample rate so billing is demonstrable end-to-end
```

- **Document types** seed as **labeled scaffolding** (Constitution II) — extensible without a code change (clarify Q2). **Document requirements are NOT seeded** (per-customer, gated §29 Input #3): a customer with no checklist rows is evaluated against the **`DEFAULT_DOCUMENT_CHECKLIST`** constant in `@brazil-tms/shared` (e.g. POD required-for-billing) and reported **document-checklist sign-off blocked** (verified in US3).
- **Storage buckets**: ensure the `documents` and `billing-exports` buckets exist (idempotent `createBucket` at setup / the documented step — mirrors how the `imports` bucket is provisioned). New env vars `DOCUMENTS_BUCKET`, `EXPORTS_BUCKET`, `DOCUMENT_MAX_BYTES` (default `10485760` = 10 MB), `DOCUMENT_CHECKS_CRON` (default `*/5 * * * *`) go in `apps/web/.env.local.example`, `workers/.env`, and the docker-compose worker env (beside `IMPORT_BUCKET`/`SLA_SWEEP_CRON`).

## Run the app AND the worker

008 needs the worker for the on-demand **`billing.export`** job and the scheduled **`documents.checks`** sweep (the **second** scheduled job after 007's SLA sweep). Run both (separate terminals), both with `DATABASE_URL` set:

```powershell
# Terminal 1 — Next.js app (BFF + UI). Upload validation, completion/billing gating, rate/billing edits, export enqueue live here.
pnpm dev

# Terminal 2 — the single Node worker (pg-boss). Runs billing.export (on-demand) + documents.checks (scheduled).
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
pnpm --filter "@brazil-tms/workers" start                 # or `... dev` for tsx watch
```

The worker registers `billing.export` as an on-demand handler (`work(...)`, no cron — enqueued by the BFF on export) and `documents.checks` via pg-boss cron (`boss.schedule(...)`, default `*/5 * * * *` via `DOCUMENT_CHECKS_CRON`). The export job writes the file to the `billing-exports` bucket + a durable `export_batches` row, then marks the included trips `billing_ready → billed` via `transitionTripStatus` (configurable lock/flag; default lock). The doc-checks sweep generates/auto-resolves the §17 `completed_missing_documents` + `billing_blocked_missing_proof` alerts through the **007 `alerts` store** and feeds the `completedMissingDocuments` dashboard metric.

Sign in and open: a trip's **/trips/:id** (documents + billing sections), **/documents** (Documents screen), **/billing** (Billing pending/ready lists + rate application + export + history), and the rate / document-requirement admin. (Finance holds `mark_billing_ready`/`edit_rates`/`export_billing`/`verify_documents`/`upload_documents`; Ops Manager holds `mark_completed`/`upload_documents`/`verify_documents`/`manage_commercial_data`; Control Tower holds `mark_completed`/`upload_documents`.)

## Verify the feature (US-by-US)

1. **US1 — Attach & verify proof documents**: on a trip, **upload** a document choosing a **type** (from the seeded master) + **external reference** (CT-e/POD number) + notes → stored in the `documents` Storage bucket, metadata row `pending_review`. Try a `.exe` or a > 10 MB file → rejected (`UNSUPPORTED_FILE_TYPE` / `FILE_TOO_LARGE`), nothing stored. As a `verify_documents` holder mark it **accepted** / **rejected** → `verified_by`/`verified_at` recorded. **Download** via the signed URL. The Trip-Detail documents section + the **missing-document list** show what required types are still unmet. A user without `upload_documents` cannot upload; without `verify_documents` cannot verify → `403`. Audit: `document.upload`/`document.verify`.
2. **US2 — Validate completion & mark Billing Ready**: take a trip at `unloaded`. With a completion-required doc missing, **mark Completed** → blocked (`409 COMPLETION_BLOCKED`); supply the doc (or pass a `waivedRequirements` waiver with a reason) → the trip transitions `unloaded → completed` then **auto-advances to `billing_pending`** with a **Billing Item** created (period = month of completion). With billing-required docs missing / no rate-or-manual amount / an open dispute, **mark Billing Ready** → blocked (`409 BILLING_READY_BLOCKED`); satisfy the §19.4 rules → `billing_pending → billing_ready`. Every transition is a `transitionTripStatus` call (records `trip_events` + `trip.status_change` audit). A waiver records who/when/why (`document.waive`). Users lacking `mark_completed`/`mark_billing_ready` → `403`.
3. **US3 — Per-customer document checklists**: as a `manage_commercial_data` holder, define a customer's required-document checklist (mark one type **required-for-completion**, another **required-for-billing**; optionally scope by lane/vehicle type) → US2's gating uses it for that customer's trips. A customer with **no** checklist falls back to `DEFAULT_DOCUMENT_CHECKLIST` and is reported **document-checklist sign-off blocked** (§29 Input #3). A user without `manage_commercial_data` cannot edit → `403`. Audit: `document_requirement.*`/`document_type.*`.
4. **US4 — Rates & billable breakdown**: as an `edit_rates` holder, create a **rate** (customer/lane/vehicle-type/effective-date, `baseAmountCents` BRL) → a matching trip's **planned freight** computes from the most-specific currently-effective rate. **Add** typed adjustments (toll, waiting time, redelivery, extra stop, penalty, discount, manual) each with amount + note → the trip shows **planned / executed / adjustment / final billable** (final = executed + tolls + extras + penalties − discounts ± manual). A trip with **no matching rate** accepts a **manual** base amount and is reported **billing-rule sign-off blocked** (§29 Input #5). A user without `edit_rates` → `403`.
5. **US5 — Export billing-ready trips + history**: on **/billing**, the pending list shows `billing_pending` trips, the ready list shows `billing_ready` trips (filter customer + period). As an `export_billing` holder, trigger an **export** (CSV or XLSX) for a customer + period → a `billing.export` worker job runs, writes the file to the `billing-exports` bucket, records an **`export_batches`** row (trip count, total, status), and marks the included trips **billed** (configurable). Re-export the same period → already-`billed` trips are excluded (no double-bill). The **export-batch history** lists prior batches with a downloadable file (signed URL). Until the exact finance format lands, the export uses the **labeled default column set** + export sign-off reported **blocked** (§29 Input #4). A user without `export_billing` → `403`. Trips still missing required proof show a **missing-proof warning** on the pending list and are excluded from the ready export. Confirm the `documents.checks` sweep surfaces them on the dashboard "Completed trips missing documents" widget + the two §17 alerts (in-app only).

Leave any surface open → it refreshes via polling (board/detail ~30 s, dashboard ~60 s; no Realtime).

## Tests

```powershell
# Pure unit (no DB): the gate evaluators + billing-value computation + checklist + vocab/Zod.
pnpm --filter "@brazil-tms/shared" test     # evaluateCompletionReadiness (§19.3 blockers), evaluateBillingReadiness (§19.4 blockers: missing billing docs / no pricing / open dispute), computeBillingValues (discounts subtracted, manual signed, planned/executed/adjustment/final), evaluateChecklist (completion vs billing missing sets), DOCUMENT_VERIFICATION_STATUSES / BILLING_ADJUSTMENT_TYPES / EXPORT_FORMATS / DEFAULT_DOCUMENT_CHECKLIST consts, document/rate/billing Zod

# Service / integration (DATABASE_URL set; run from repo root with --project web):
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
pnpm exec vitest run --project web          # uploadDocument (type/size reject, Storage put + row) / verifyDocument / archiveDocument; markCompleted (gate block → COMPLETION_BLOCKED; waiver satisfies; auto-advance to billing_pending; ensureBillingItem with period); markBillingReady (BILLING_READY_BLOCKED on missing docs/pricing/dispute); resolveRate precedence (lane+vt > single-scope > customer-default, tie-break effective_start; no match ⇒ manual + blocked); addBillingAdjustment + computeBillingValues; createExportBatch (NO_BILLABLE_TRIPS guard, enqueue); read-model fills (loadTripDetail documents[]/billing; queryDashboardMetrics completedMissingDocuments; queryBillingList; queryExportBatches)

# Playwright e2e (UI + authz + HTTP statuses — run against a PROD build, --workers=1):
pnpm db:seed:e2e                            # reset accounts polluted by role-change specs (001/002)
pnpm --filter "@brazil-tms/web" test:e2e    # upload/verify/download; completion + billing-ready gating + waiver; rate admin + billable breakdown; document-requirement/type admin; billing pending/ready lists; export + batch history + download; "Missing documents" view + dashboard widget; authz (upload_documents/verify_documents/mark_completed/mark_billing_ready/edit_rates/export_billing 200 vs 403; manage_commercial_data for checklists); HTTP statuses (400/403/404/409: COMPLETION_BLOCKED, BILLING_READY_BLOCKED, UNSUPPORTED_FILE_TYPE, FILE_TOO_LARGE, NO_BILLABLE_TRIPS, NOT_FOUND, STALE_TRANSITION)

# Worker jobs test (DATABASE_URL set):
pnpm --filter "@brazil-tms/workers" test    # runBillingExport: selects billing-ready trips, ExcelJS xlsx/csv buffer, putExport, export_batches status completed, trips → billed; failure → batch failed + error_message; idempotent retry skips billed trips. runDocumentChecks: sweeps billing-phase trips, generates the 2 §17 alerts idempotently (ON CONFLICT — re-run no duplicate), auto-resolves on clear, per-trip fault isolation
```

Run a single web integration file, e.g.: `pnpm exec vitest run --project web apps/web/lib/trips/completion.test.ts` (with `DATABASE_URL` set). Test focus per STACK §3.13 + constitution: the **pure completion/billing-readiness gate evaluators** + **billing-value computation** (Vitest, no DB), the **services** + read-model + **worker jobs** (integration with `DATABASE_URL`), and the UI + authz + HTTP-status assertions (Playwright). **HTTP-status assertions live in Playwright `e2e/`, not `route.test.ts`** (web Vitest only includes `lib/**`). Reset polluted accounts with `pnpm db:seed:e2e` and run e2e against a **prod build** with `--workers=1`; a stale `next dev` can hold broken HMR state and cause false 500s (MEMORY).

## Performance sanity (SC-010)

A manual spot-check at the design scale (**medium / low-thousands of trips**, inherited from 005/007). With the `documents_*` / `rates_*` / `billing_items_*` / `export_batches_*` indexes:

- The **pure gate evaluators** + `computeBillingValues` are sub-millisecond.
- The **Documents screen**, **Billing pending/ready lists**, and the **Trip-Detail documents/billing sections** load within **~3 s** at medium scale (the §21.2 trip-**list** bar — an intentional relaxation of §21.2's 2 s trip-**detail** bar for these new Storage/billing-backed sections).
- A **billing export** over a customer+period batch (up to ~hundreds of trips) completes on the worker within a configurable soft target (~a few minutes) with a durable `export_batches` status; the **`documents.checks`** sweep over billing-phase trips completes within its ~5-min cadence.

If a list exceeds the bound at medium scale, confirm the new indexes are present (`\d documents`, `\d rates`, `\d billing_items`, `\d export_batches`).

## Quality gate before PR (targets dev)

```powershell
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

Use the PR template (what/why/how-to-test/migration notes/risks). Note in the PR that 008 **first-enforces `upload_documents` / `verify_documents` / `mark_completed` / `mark_billing_ready` / `edit_rates` / `export_billing`** (and reuses `manage_commercial_data` for document requirements + types), adds **seven tables + three enums + two Storage buckets + two worker jobs** (no new permission key/package/worker process/runtime dep/`trips` ALTER), reuses the 003 status machine + `billingStatus` projection (completion/Billing-Ready are transitions, billing status is projected) and the 007 `alerts` store (lighting up the two deferred §17 cases), keeps `trip_events`/`audit_logs` append-only, and that **per-customer required proof documents (§29 Input #3) / the finance export format (#4) / per-customer billing rules (#5)** are **gated business inputs — configurable defaults + blocked sign-off, not invented** (Constitution II). AI does not merge to `main`.
