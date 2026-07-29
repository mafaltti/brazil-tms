# Feature 008 — Self-test guide (Documents, Completion, Billing Readiness, Rates & Export)

How to stand up the local stack and exercise the **proof-and-money close-out**: attach + verify proof
documents, gate **Completed** and **Billing Ready** on the per-customer required-document checklist +
pricing + dispute rules, maintain rates + a typed billable breakdown, and **export** billing-ready
trips to CSV/XLSX with durable batch history. Host: Windows + PowerShell. Prereqs: Docker Desktop
running, Node 20+/pnpm, `pnpm install` already done. This slice builds on the trip domain (003),
import + Storage/worker patterns (004), the control-tower shell (005), and the 007 `alerts` store.

What's different from earlier slices:

- **Supabase Storage is back** (like 004, unlike 007): two **private buckets** — `documents` and
  `billing-exports` — must exist. There's an idempotent seed for it (`db:seed:buckets`). See §1.
- The worker now runs **two** jobs: the on-demand **`billing.export`** (heavy file generation off the
  request path) and the **second scheduled cron**, **`documents.checks`** (the §17 doc/billing alerts,
  every 5 min by default). So unlike 007, you need the worker for **two** manual sections (§5.5 export,
  §5.6 alerts) — the rest works **with the app alone**.
- **Completed** and **Billing Ready** are **not** new tables — they are transitions on the existing
  003 status machine. "Billing status" is the `billingStatus(current_status)` projection (no stored
  column, no `trips` ALTER). Completion **auto-advances** to `billing_pending` and creates a Billing
  Item in the same call.
- Freshness is **polling** (TanStack Query) — no Realtime (board/detail ~30 s, dashboard ~60 s).

> Your local `.env` files already exist (gitignored): `infra/supabase/.env`, `apps/web/.env.local`,
> `packages/db/.env`, `workers/.env`. 008 adds **no required** env var — all four have sensible
> defaults: `DOCUMENTS_BUCKET` (`documents`), `EXPORTS_BUCKET` (`billing-exports`), `DOCUMENT_MAX_BYTES`
> (`10485760` = 10 MB), `DOCUMENT_CHECKS_CRON` (`*/5 * * * *`). Override any of them in `workers/.env` /
> `apps/web/.env.local` if you want.

## 1. Bring it up

```powershell
docker compose -f infra/supabase/docker-compose.yml up -d   # Postgres + GoTrue + gateway + Mailpit
# Wait until GoTrue is healthy:
curl http://localhost:8000/auth/v1/health                   # -> HTTP 200 {"name":"GoTrue",...}

pnpm --filter @brazil-tms/db db:migrate                     # applies through 0007 (7 tables, 3 enums, NO trips ALTER)
pnpm --filter @brazil-tms/db db:seed:e2e                    # role accounts (table in §2)
pnpm --filter @brazil-tms/db db:seed:master-data           # customer "Shopee (Demo)" (DEMO-SHOPEE) + lanes + locations
pnpm --filter @brazil-tms/db db:seed:trip-domain           # sample trips across statuses, incl. some at `unloaded` (completion-ready)
pnpm --filter @brazil-tms/db db:seed:document-types        # 5 proof types (pod, cte, mdfe, gate_receipt, portal_ref) — §3
pnpm --filter @brazil-tms/db db:seed:rates                 # OPTIONAL: one sample base rate so billing is demonstrable
pnpm --filter @brazil-tms/db db:seed:buckets               # provisions the `documents` + `billing-exports` buckets (idempotent)
```

> `db:migrate` runs **all** migrations 001→0007. 0007 adds the seven 008 tables (`document_types`,
> `documents`, `document_requirements`, `rates`, `billing_items`, `billing_adjustments`,
> `export_batches`), three enums (`document_verification_status`, `export_batch_status`,
> `billing_adjustment_type`), and indexes. It drops nothing and does **not** ALTER `trips`.
> `db:seed:buckets` needs the Supabase stack up + `SUPABASE_SERVICE_ROLE_KEY` (already in `workers`/`db`
> `.env`); it ensures `imports`, `documents`, and `billing-exports`.

**Run the app** (always) and **the worker** (for §5.5 export + §5.6 alerts). Both need `DATABASE_URL`:

```powershell
# Terminal A — app (BFF + all 008 screens) on http://localhost:3000
pnpm --filter @brazil-tms/web dev
# Terminal B — the single worker. Now runs billing.export (on-demand) + documents.checks (scheduled).
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
pnpm --filter @brazil-tms/workers start          # logs the import worker + "sla.sweep" + "documents.checks"
```

> To watch the **document-checks** alert path quickly (§5.6), set the sweep to every minute before
> starting the worker: add `DOCUMENT_CHECKS_CRON=* * * * *` to `workers/.env` (default is every 5 min).
> The worker also needs `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` + the bucket names for the
> export job's Storage write (all already in `workers/.env`).

- Mailpit (part of the stack, unrelated to 008): **http://localhost:8025**
- Host port 5432 taken? `SUPABASE_DB_PORT=5433` is already set in `infra/supabase/.env`.

## 2. Test accounts (from `db:seed:e2e`)

Passwords are per-account (see `packages/db/seed/e2e-accounts.ts`). 008 **first-enforces six**
pre-declared permission keys and **reuses** `manage_commercial_data` (+ `view_all_trips` for reads):

| Email | Password | Role | Upload | Verify | Complete | Billing Ready | Rates + billing edit | Export | Checklists/types |
|---|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| admin@braziltransports.com.br | `ChangeMe!Admin123` | Admin | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| opsmanager@braziltransports.com.br | `ChangeMe!Ops123` | Operations Manager | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ |
| finance@braziltransports.com.br | `ChangeMe!Finance123` | Finance | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ |
| dispatcher@braziltransports.com.br | `ChangeMe!Dispatcher123` | Dispatcher | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| fleetcoord@braziltransports.com.br | `ChangeMe!Fleet123` | Fleet Coordinator | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

Permission keys behind the columns: upload = `upload_documents`; verify = `verify_documents`;
complete = `mark_completed`; billing ready = `mark_billing_ready`; rates + billing edit (rate CRUD,
manual base, adjustments) = `edit_rates`; export = `export_billing`; checklists/types =
`manage_commercial_data` (reused). **All reads** — board, Billing lists, Documents screen, a trip's
documents, **and document downloads** — are gated by `view_all_trips` (every role above has it); the
**export-file** download needs `export_billing`.

> Not seeded as accounts: **Control Tower** (the other `mark_completed` holder — Admin/Ops/**Control
> Tower** — that can complete trips + upload but cannot mark Billing Ready) and **Executive Viewer**
> (read-only). To exercise them, change a user's role in `/admin/users`, or rely on the
> `ROLE_PERMISSIONS` unit tests.
>
> Key distinctions worth testing: **Finance is the money role** (billing-ready + rates + export +
> verify), but it **cannot** mark Completed or edit checklists. **Operations Manager** owns Completed +
> the checklist/type master, but **not** billing-ready/rates/export. **Dispatcher/Fleet Coordinator can
> only upload** proof — they cannot verify it.

## 3. Seeded data (documented-default scaffolding — Constitution II)

- **Document types** (`db:seed:document-types`, idempotent on `code`): five MVP proof types with pt-BR
  labels — `pod` (Comprovante de entrega), `cte` (CT-e), `mdfe` (MDF-e), `gate_receipt` (Comprovante de
  portaria), `portal_ref` (Referência do portal do cliente). **Labeled scaffolding**, not final
  business sign-off — extensible from the type-master admin without a code change.
- **`DEFAULT_DOCUMENT_CHECKLIST`** (in `@brazil-tms/shared`, code constant — **not** seeded as rows):
  a single entry, **POD `required-for-billing`** (not for completion). Any customer with **no**
  `document_requirements` rows is evaluated against this default → so such a trip can be **Completed
  without POD** but **cannot reach Billing Ready** without it, and the customer is reported
  **document-checklist sign-off blocked** (`hasExplicitChecklist=false`, §29 Input #3).
- **Document requirements are NOT seeded** (per-customer, a gated business input). Define them in §5.3.
- **Sample rate** (`db:seed:rates`, optional): one base rate for the demo customer so a completed trip
  prices automatically and the billable breakdown + export are demonstrable end-to-end. Skip it to
  exercise the **no-rate → manual base → billing-rule sign-off blocked** path (§29 Input #5).
- **Sample trips** (`db:seed:trip-domain`): trips across lifecycle statuses, including some at
  `unloaded` — the entry point for the Completed → Billing Ready flow (§5.2).

> Real per-customer required documents (#3), the finance export column format (#4), and per-customer
> billing rules for toll/waiting-time/penalty/cancellation (#5) remain **BLOCKED** on customer files
> (PRD §29). This guide exercises the engine with documented-default scaffolding, not final configs.

## 4. Automated tests

```powershell
pnpm lint ; pnpm typecheck ; pnpm build           # static gate (route exports, types, build)

# Unit only (no DB): the pure gate evaluators + billing-value computation + Zod. Integration suites SKIP here.
pnpm test

# Integration (DB-backed): the suites un-skip ONLY when DATABASE_URL is set. They share the one dev DB,
# so run serially with --no-file-parallelism. The WORKER suites also need Storage env (export/doc files):
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
pnpm exec vitest run --project web --no-file-parallelism      # documents, requirements, completion, rates,
                                                              # billing-items, billing/export read models, trip-transitions
# Worker jobs need DATABASE_URL + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + DOCUMENTS_BUCKET + EXPORTS_BUCKET
# (easiest: load workers/.env into the session first), then:
pnpm exec vitest run --project workers --no-file-parallelism  # billing-export (xlsx/csv, idempotent, atomic bill+link),
                                                              # document-checks (§17 alert cases 7+8)

# End-to-end (app running; e2e accounts seeded). Reset accounts first (role-change specs pollute them):
pnpm --filter @brazil-tms/db db:seed:e2e
$env:PLAYWRIGHT_BASE_URL='http://localhost:3000'
pnpm --filter @brazil-tms/web exec playwright test `
  e2e/documents.spec.ts e2e/document-requirements.spec.ts e2e/completion-billing.spec.ts `
  e2e/rates-billing.spec.ts e2e/billing-export.spec.ts e2e/documents-billing-authz.spec.ts --workers=1
```

> Why `pnpm test` shows tests "skipped": every DB-backed suite is guarded by
> `describe.skipIf(!process.env.DATABASE_URL)`, so the default run stays green without a database. The
> **pure gate evaluators** (`evaluateCompletionReadiness` / `evaluateBillingReadiness`) and
> `computeBillingValues` are in `@brazil-tms/shared` and **do** run in the unit pass — they are the
> single server-authoritative authority the BFF and the worker both call. Run e2e against a **prod
> build** with `--workers=1`; a stale `next dev` can hold broken HMR state and cause false 500s.

The 008 integration + worker suites and what they cover:

| Suite | Covers |
|---|---|
| `apps/web/lib/trips/documents.test.ts` | `uploadDocument` (type/size reject + Storage put + row), `verifyDocument`, `archiveDocument`, `getDocumentFileKey` (archived → null) |
| `apps/web/lib/trips/requirements.test.ts` | `resolveRequiredTypes` (additive unscoped + scoped), `loadChecklistStatus`, DEFAULT fallback + sign-off blocked, requirement/type CRUD + missing-id 404 guard |
| `apps/web/lib/trips/completion.test.ts` | `markCompleted` (`COMPLETION_BLOCKED` → waiver/accepted doc satisfies → auto-advance `billing_pending` + Billing Item), `markBillingReady` (`BILLING_READY_BLOCKED`) |
| `apps/web/lib/trips/rates.test.ts` | `resolveRate` precedence (lane+vehicle-type > single-scope > customer-default; effective-date tie-break), `createRate`/`updateRate` + 404 |
| `apps/web/lib/trips/billing-items.test.ts` | `ensureBillingItem`, `addBillingAdjustment`, `computeBillingValues` (discount negated, manual signed, planned/executed/adjustment/final) |
| `apps/web/lib/trips/trip-transitions.test.ts` | the 003 transition service + the new `txHook` **atomicity** (link commits with the transition; a throwing hook rolls the whole transition back) |
| `apps/web/lib/billing/export.test.ts` | `queryBillingList`, `createExportBatch` (`NO_BILLABLE_TRIPS` guard + enqueue), `queryExportBatches` |
| `workers/jobs/billing-export/billing-export.test.ts` | `runBillingExport` (xlsx + csv, idempotent retry, permanent-link / no-strand, atomic bill+link) → trips `billing_ready → billed`; failure → batch `failed` |
| `workers/jobs/document-checks/document-checks.test.ts` | `runDocumentChecks` (cases 7 + 8 fire/auto-resolve **idempotently**, per-trip fault isolation) |
| `packages/shared/src/domain/{documents,billing}.test.ts` | **pure**: completion/billing-readiness gates, `computeBillingValues`, `evaluateChecklist`, `DEFAULT_DOCUMENT_CHECKLIST` |

> HTTP-status + authz assertions (401/403/404/409) live in the Playwright `e2e/` specs, **not** in
> `route.test.ts` (web Vitest only includes `lib/**`).

## 5. Manual walkthrough (maps to the spec's user stories)

Open **http://localhost:3000**, sign in. UI is **pt-BR**. Most sections work with the app alone; the
worker (Terminal B) is needed for **§5.5** (export) and **§5.6** (the doc/billing alerts).

### 5.0 Authz (first-enforced keys)
- Logged out: any `/api/...` 008 route → **401**.
- As **dispatcher@**: you can upload proof, but **verify** is hidden / `PATCH /api/documents/:id` →
  **403**; `POST /api/trips/:id/complete` → **403**; `POST /api/rates` → **403**.
- As **opsmanager@**: you can complete trips + edit checklists, but `POST /api/trips/:id/billing-ready`,
  `POST /api/rates`, and `POST /api/billing/exports` → **403** (those are Finance/Admin).
- As **finance@**: you can verify, price, mark Billing Ready, and export, but `POST
  /api/trips/:id/complete` and `POST /api/document-requirements` → **403**.

### 5.1 US1 — attach & verify proof documents
1. Open a trip on the board (`/trips`) → **Trip Detail** (`/trips/[id]`) → the **Documents** section
   (filled from the 005 placeholder). As **dispatcher@** (or anyone with upload): pick a **type** (from
   §3), add an **external reference** (e.g. a CT-e / POD number) + notes, choose a **PDF/JPG/PNG** file,
   **Upload**. The row appears as **`pending_review`**. (`POST /api/trips/:id/documents`, multipart
   `file` + JSON `meta`; audit `document.upload`.)
2. Validation runs **before** anything is stored: a `.exe`/`.zip` → **409 `UNSUPPORTED_FILE_TYPE`**; a
   file > ~10 MB → **409 `FILE_TOO_LARGE`**; a missing/inactive type → **409 `INVALID_DOCUMENT_TYPE`**;
   an unknown trip → **404 `NOT_FOUND`**. Nothing lands in Storage on any of these.
3. As **finance@** (or opsmanager@): **verify** the document — **accept** or **reject**
   (`PATCH /api/documents/:id`, records `verified_by`/`verified_at`; audit `document.verify`). Only an
   **accepted** (or **waived**, §5.2) document satisfies a checklist requirement — a **rejected** one
   does not.
4. **Download**: the Download control returns a **60-second signed URL** to the private bucket (`GET
   /api/trips/:id/documents/:docId/download`, `view_all_trips`); the service-role key never leaves the
   server. A waiver row (no file) or unknown id → **404**.
5. **Archive** a document (soft-delete) → it drops off the section but the row + audit persist
   (`document.archive`); an archived document no longer satisfies any requirement, and its download
   404s.
6. The Documents section also shows the **missing-required list** for the trip's customer checklist; the
   cross-trip **Documents screen** (`/documents`) lists trips still missing required proof.

### 5.2 US2 — Completed & Billing Ready (gated transitions)
The gates are **server-authoritative** (the UI never decides). Both are transitions on the 003 machine.
1. Take a trip at **`unloaded`** (from `db:seed:trip-domain`). As **opsmanager@** (or admin@/Control
   Tower), **Mark Completed**. If a **completion-required** document is unmet → **409
   `COMPLETION_BLOCKED`** with the missing type ids in `findings`; the trip stays `unloaded`.
2. Satisfy it two ways: **(a)** upload + **accept** the document (§5.1), **or** **(b)** record an
   **unavailable-with-reason waiver** — pass `waivedRequirements: [{ documentTypeId, reason }]` to the
   same Mark-Completed call (a waiver is an audited human decision: `document.waive`, recorded inside
   the gated transition). Retry → **200**: the trip transitions `unloaded → completed` and
   **auto-advances to `billing_pending`** with a **Billing Item** created (period = month of completion,
   America/Sao_Paulo). Each step records `trip_events` + `trip.status_change` audit.
3. As **finance@**, **Mark Billing Ready** (`POST /api/trips/:id/billing-ready`). If a
   **billing-required** document is unmet, there's **no pricing** (no rate and no manual base), or
   there's an **open dispute** → **409 `BILLING_READY_BLOCKED`** with the blockers. Satisfy the §19.4
   rules (§5.4 for pricing) → **200**: `billing_pending → billing_ready`. "Billing status" everywhere is
   the `billingStatus(current_status)` projection — there's no stored billing column.
4. Note the split: **opsmanager@ cannot** Mark Billing Ready (Finance/Admin), **finance@ cannot** Mark
   Completed (Ops/Control-Tower/Admin) — both return **403**.

### 5.3 US3 — per-customer required-document checklists
1. As **opsmanager@**/admin@, open **`/admin/document-requirements`** (reuses `manage_commercial_data`).
   It holds two panels: **document requirements** and the **document-type master**.
2. In the type master, **add a type** (code + pt-BR label) — appears alongside the five seeded types
   (`document_type.create`). In requirements, **select a customer** and **add a requirement**: mark a
   type **Bloqueia conclusão** (required-for-completion) and/or **Bloqueia faturamento**
   (required-for-billing), optionally scoped to a **lane / vehicle type**
   (`document_requirement.create`).
3. **Additive resolution**: an unscoped row **plus** any matching lane/vehicle-type rows all apply to a
   trip (flags OR-ed). Now redo §5.2 for that customer's trip — the gate uses **its** checklist.
4. A customer with **no** requirement rows falls back to `DEFAULT_DOCUMENT_CHECKLIST` (POD billing-only)
   and the panel shows **"Sem lista configurada — homologação pendente"** (sign-off **blocked**, §29
   Input #3). As **dispatcher@**: the read loads but `POST/PATCH` → **403**.

### 5.4 US4 — rates & the typed billable breakdown
1. As **finance@**/admin@, open **`/billing/rates`** (`edit_rates`). **Create a rate**: customer
   (+ optional lane / vehicle type), **base amount** (BRL), and an **effective window**
   (`rate.create`). Precedence at match time: **lane+vehicle-type > single-scope > customer-default**,
   tie-break latest `effective_start`; outside the window ⇒ no match.
2. Open a `billing_pending` trip's **Billing** section on **Trip Detail**. With a matching rate, the
   **planned/executed** base is filled from the rate. With **no** rate, set a **manual base** (`PATCH
   /api/trips/:id/billing { baseFreightCents }`) — the trip is then reported **billing-rule sign-off
   blocked** (§29 Input #5; the system never invents a rate).
3. **Add typed adjustments** (`POST /api/trips/:id/billing/adjustments`): `toll`, `waiting_time`,
   `redelivery`, `extra_stop`, `penalty`, `discount`, `manual_adjustment`. Watch the breakdown:
   **final = base + Σ(adjustments)** with **discounts subtracted** and `manual_adjustment` signed (e.g.
   base 150000 + toll 10000 − discount 25000 = **135000** centavos). Values are a **computed
   projection** (`computeBillingValues`) — never stored. **Remove** an adjustment (`DELETE
   /api/billing-adjustments/:id`) → it's soft-removed and drops out of the total. Each write audits
   `billing_item.update`.

### 5.5 US5 — export billing-ready trips + history *(worker required)*
1. On **`/billing`**, the **pending list** shows `billing_pending` trips and the **ready list** shows
   `billing_ready` trips — both **filterable by customer + period**, each row showing the computed
   final value + a **missing-proof** indicator.
2. As **finance@**, trigger an **export** for a **customer + period** in **CSV** or **XLSX** (`POST
   /api/billing/exports`, `export_billing`). The request returns **202** with a **queued**
   `export_batches` row and enqueues the **`billing.export`** worker job; with no billing-ready trips
   for that period → **409 `NO_BILLABLE_TRIPS`**.
3. Watch **Terminal B**: the worker runs the job, writes the file to the `billing-exports` bucket, and
   flips the batch `queued → running → completed` with `trip_count` + `total_amount_cents`. The included
   trips transition **`billing_ready → billed`** (atomically linked to the batch). **Re-export** the
   same period → already-`billed` trips are **excluded** (no double-billing).
4. The **export-batch history** on `/billing` lists prior batches; **Download** issues a signed URL to
   the file (`export_billing`). Until the finance format lands, the export uses the **labeled default
   column set** and export sign-off is reported **blocked** (§29 Input #4).

### 5.6 The two §17 alerts + the `documents.checks` sweep *(worker required)*
These are the two §17 cases 007 deferred, now lit through the **007 `alerts` store**. They fire from the
scheduled **`documents.checks`** sweep (not synchronously).
1. Set `DOCUMENT_CHECKS_CRON=* * * * *` in `workers/.env` and (re)start the worker. The sweep evaluates
   **billing-phase** trips (`billing_pending` / `billing_ready`).
2. A trip with **any** unmet required document → **`completed_missing_documents`**. A trip missing a
   **required-for-billing** document → **`billing_blocked_missing_proof`** (keyed on the
   `missing_billing_documents` blocker — it does **not** fire on `no_pricing`/dispute alone). Both are
   **in-app only** (no email/SMS/webhook),
   **idempotent** (no duplicate while still true), and **auto-resolve** when you accept/waive the
   document. The worker logs a per-sweep summary (`duration_ms / evaluated / alerts_created /
   alerts_resolved / errors`).

### 5.7 The 005-shell fills (dashboard widget + board view)
1. **Dashboard** (`/`): the **"Completed trips missing documents"** widget (filled from the 005
   placeholder) counts billing-phase trips with unmet required-for-billing proof — fed by the
   `documents.checks` sweep / `completedMissingDocuments` metric (~60 s polling).
2. **Board** (`/trips`): pick the **"Missing documents"** view preset (filter `missingDocuments=true`)
   to narrow to exactly those trips. (007's "Billing pending" view is also available here.)

## 6. Tear down

```powershell
docker compose -f infra/supabase/docker-compose.yml down -v   # stop + wipe the DB volume
# stop the app (Ctrl+C in Terminal A) and the worker (Ctrl+C in Terminal B)
```

> `down -v` wipes the database **and** the Storage volume; re-run the §1 migrate + seeds (including
> `db:seed:buckets`) after a fresh bring-up. Per-customer required documents, the export format, and
> per-customer billing rules remain **BLOCKED** on real customer files — this guide exercises the engine
> with documented-default scaffolding, not final configs.
