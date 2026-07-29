# Phase 0 Research: Trip Import, Templates, Validation, and Duplicate Handling

**Feature**: 004-trip-import-validation | **Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)

All spec clarifications are resolved (Session 2026-05-30). This document records the design decisions for the first
slice that activates the **worker + Postgres-backed queue**. Four **business inputs remain BLOCKED** (real Shopee/DHL/ML
files; per-customer status vocabularies; fuzzy-duplicate tolerance values; required-field overrides) — scaffolded as
config-driven documented defaults, **not** invented (Constitution II). Decisions are grounded in `docs/STACK.md`
(§3.4, §3.5, §3.9, §3.11, §3.12, §6.3, §7), the constitution (Principles I, III, IV, V), and slice 003's reuse contract.

## R0 — Build on 001/002/003; reuse, do not redefine

- **Decision**: 004 adds only the import surface. It **calls** 003's trip-write services and **imports** `TRIP_STATUSES`,
  `TRANSITIONS`, `canTransition`, `billingStatus`, `TRIP_CRITICAL_FIELDS` from `@brazil-tms/shared`; resolves references
  against 002's `customers.customer_code`, `locations (customer_id, code)`, `lanes (customer, origin, dest)`; reuses
  001's `requireAuth`/`requirePermission`, `writeAudit`, `handleRouteError`/`Conflict`, the Drizzle client. It activates
  the trips `import_batch_id` forward hook and uses `trip_event_source = 'import'`.
- **Rationale**: SPEC-SLICING slice 004 exit criterion — "accepted rows create or update trips **through the shared trip
  domain model**"; Constitution VI (specs reference, don't duplicate); FR-028 forbids redefining the status machine/audit.
- **Alternatives**: a standalone import data model with its own trip table (rejected — duplicates the system of record,
  breaks the single status machine and audit trail).

## R1 — Job queue library: `pg-boss`

- **Decision**: Use **`pg-boss`** as the Postgres-backed queue driving the single Node worker.
- **Rationale**: STACK §3.11 sanctions `pg-boss` *or* `graphile-worker`; this is a genuine choice. `pg-boss` fits best:
  JS/Node-native typed API, durable job state in the **same Postgres** that holds `import_batches`/`import_rows` (no
  Redis — honors the broker exclusion), built-in retry/archival, mature/maintained (2025). 004 needs no cron, so
  graphile-worker's scheduling/latency edge is irrelevant; we run no PostGraphile.
- **Alternatives**: `graphile-worker` (rejected — SQL/PostGraphile-centric strengths and sub-ms latency we don't need;
  0.x type churn). Redis/BullMQ/external broker (**excluded by constitution**).

## R2 — Trip writes from the worker: promote 003's trip-write path into `@brazil-tms/db`

- **Decision**: The confirm-import **job runs in the worker** and must **call** 003's `createTrip` / `updateTripPlan`
  (FR-027/FR-028) — but those live in `apps/web/lib/trips/*` (`server-only`, with apps-local `writeAudit` and `Conflict`),
  which a separate process cannot import. **Promote the canonical trip-write services + `writeAudit` + the `Conflict`/typed
  errors into `@brazil-tms/db`** (`packages/db/src/trips`, `…/src/audit/write-audit.ts`, `…/src/errors.ts`). `apps/web`
  re-exports them (`apps/web/lib/trips/*`, `…/lib/audit/write-audit.ts`, `…/lib/api/respond.ts`) so all 003 callers and
  tests keep working unchanged. The worker imports the canonical functions from `@brazil-tms/db`. The relocation also
  moves the co-located **reads** (`getTrip`/`listTrips`) and the shared **`trip-dto.ts`** (`TripDetail`/`loadTripDetail`/
  `toTripSummary`) that all four services return — splitting writes from reads only by import path, not by behavior.
  `cancelTrip` moves too (promote the trip-write module as one unit) even though 004 does not call it. The promoted
  modules keep their `server-only` guard and are never imported by client components. **Only the framework-free `Conflict`
  / typed-error classes** move to `@brazil-tms/db/src/errors.ts`; the Next-coupled `handleRouteError`/`apiError` **stay**
  in `apps/web/lib/api/respond.ts` (which re-imports the promoted `Conflict`), so the worker never pulls `next/server`.
- **Rationale**: One implementation, two consumers (BFF + worker) — satisfies the reuse contract *without* redefining
  (FR-028) and *without* a new package (Constitution I: both web and worker already depend on `@brazil-tms/db`, which is
  the durable-model + DB-transaction package where this logic belongs). Re-exports preserve every existing public import
  path, so the change is path-relocation plus a write/read import split — no behavior change.
- **Alternatives**: re-implement trip create/update in the worker using only the shared enums + Drizzle (rejected —
  violates FR-028 "MUST NOT redefine"); run confirmation synchronously in the BFF route handler (rejected — creating
  ~1000 trips per request exceeds web-request expectations, STACK §2/§6.3); worker calls back to the web app over HTTP
  per row (rejected — needless coupling/latency, an internal public surface to secure); a new `packages/domain` (rejected
  — `@brazil-tms/db` already serves both consumers; no third package needed, Constitution I).

## R3 — Worker process structure (activate the `workers/` stub)

- **Decision**: `workers/index.ts` boots `pg-boss` (create schema, `start()`, register handlers, graceful shutdown).
  Job handlers are folders under `workers/jobs/` per STACK §7: `parse`, `validate`, `detect-duplicates`,
  `generate-error-report`, `confirm-import`. The first four form a **chained pipeline** (each enqueues the next on
  success); `confirm-import` is enqueued by the user's confirm action. `workers/lib/queue.ts` centralizes typed enqueue
  helpers (job names + Zod payloads from `@brazil-tms/shared`); `workers/lib/batch-progress.ts` updates durable batch
  status/counters. Handlers import the Drizzle client from `@brazil-tms/db` and schemas from `@brazil-tms/shared`.
- **Rationale**: STACK §7 ("jobs are folders inside the worker, not separate packages"; single `index.ts` entrypoint);
  §6.3 puts long imports/parsing in the worker. **Constitution I**: the worker is the sanctioned "one app + one worker"
  shape and exists to move heavy work off the request path — not speculative. Chaining keeps each stage idempotent and
  restartable (STACK §3.11).
- **Alternatives**: one monolithic "process import" job (rejected — the spec + STACK enumerate the five jobs; separate
  stages give per-stage progress/retry and clearer failure attribution); per-job packages (rejected — §7, Principle I).

## R4 — File upload flow (App Router): fast BFF path, slow worker path

- **Decision**: `POST /api/imports` (Route Handler) does only the **fast** path: `requirePermission(ctx,'import_trips')`,
  Zod-validate metadata (customerId, optional templateId), read the file via `request.formData()`, stream the **original**
  file to **Supabase Storage** via the server-only service-role client, insert `import_batches` (status `received`),
  enqueue a `parse` job `{ batchId, storageKey }`, return **`202 { id }`**. The worker does parse/validate/dedup/report.
- **Rationale**: STACK §3.9 (binaries in Storage, metadata in Postgres), §3.11 (enqueue → worker), §2/§6.3 (no heavy
  work in handlers), Constitution IV (service-role server-only). **App Router gotcha**: Route Handlers have **no
  per-route `bodySizeLimit`**; the cap is enforced upstream. We self-host behind **Caddy**, so the upload-size limit is
  raised at the proxy and the form file is streamed straight to Storage (no full buffering). Server Actions are avoided
  (their 1 MB default + diverging from the declared BFF Route-Handler surface).
- **Alternatives**: parse synchronously in the handler (rejected — §2/§6.3); Server Action upload with
  `serverActions.bodySizeLimit` (rejected — not the declared BFF surface).

## R5 — Parsing libraries: `csv-parse` (streaming) + `exceljs`; explicit Luxon dates

- **Decision**: **`csv-parse`** (streaming) for CSV; **`exceljs`** for XLSX (read, and writing the error report). Parse
  **row-by-row**, carrying the original **1-based file row number** with each record. Normalize all customer dates/numbers
  **explicitly with Luxon** per the template's parsing rules (format + zone `America/Sao_Paulo` → UTC); never use implicit
  JS `Date`. Both libs are **worker-only** — the worker is a plain Node process (not bundled by Next), so no `apps/web`
  `serverExternalPackages` entry is needed and `apps/web` never imports them.
- **Rationale**: STACK §3.12 names both libraries and requires preserving original file/row references; §3.5 forbids
  implicit `Date` parsing of customer files. Streaming bounds worker memory on large files (§6.3).
- **Alternatives**: whole-file/SheetJS parsing (rejected — §3.12 specifies these; whole-file buffering breaks the memory
  bound on large XLSX); native `Date.parse` (excluded by §3.5).

## R6 — Import-row staging: a durable `import_rows` table

- **Decision**: Stage every parsed row in a durable **`import_rows`** table — `(id, import_batch_id, row_number, raw jsonb,
  mapped jsonb, outcome enum, reasons jsonb, match_decision enum, target_trip_id, applied_at)` — not a jsonb array on the
  batch.
- **Rationale**: (a) **traceability** — original `row_number` + `raw` preserved (STACK §3.12, Constitution III); (b)
  **idempotency** — per-row `outcome`/`match_decision`/`target_trip_id`/`applied_at` let confirm be re-run per row (R8);
  (c) **scale** — index/paginate per row instead of rewriting one giant blob; the preview table reads rows directly.
- **Alternatives**: jsonb array on `import_batches` (rejected — no per-row indexing, whole-blob rewrites, weak idempotency
  anchor, poor traceability at scale).

## R7 — Matching & duplicate semantics

- **Decision**: In `detect-duplicates`, for each non-error row:
  1. **Match key** = `(customer_id, external_trip_id)`. Look up an existing trip.
     - none → `match_decision = new`;
     - exists + a mapped plan field differs → `update`;
     - exists + identical → `no_op` (reported unchanged).
  2. **In-file collision**: if ≥2 rows in the same batch share `(customer_id, external_trip_id)`, **all** are
     `outcome = error` (`reasons: IN_FILE_COLLISION`), created/updated by none (FR-017a, clarification).
  3. **Potential (fuzzy) duplicate**: a row with **no external-ID match** whose fuzzy key — `customer + origin +
     destination + pickup-window + vehicle type` within a **configurable tolerance** — matches an existing trip is
     `match_decision = potential_duplicate` (`outcome = warning`); it may be created only with a **recorded reason**.
  4. A repeated external ID is **never** a blocking duplicate (FR-021). `warning` rows are applied on confirm; `error`
     rows are not.
- **Rationale**: PRD §19.1, Decision §30, spec FR-017..FR-024. The trips partial unique index `(customer_id,
  external_trip_id)` makes the match key authoritative. Tolerance is **configuration with a documented default** (Ops
  confirms final values against real files — BLOCKED).
- **Alternatives**: auto-creating fuzzy matches (rejected — silent duplicates); treating a repeated external ID as a hard
  duplicate (rejected — explicitly forbidden, §19.1).

## R8 — Idempotent confirmation (per-row best-effort)

- **Decision**: `confirm-import` iterates `import_rows` for the batch with `outcome ∈ {valid, warning}` and
  `applied_at IS NULL`. Per row, in one transaction it **calls the promoted trip-write service** (R2):
  `new → createTrip`; `update → updateTripPlan(..., { authorizedReview })`; `no_op → link only`. It then sets
  `target_trip_id` + `applied_at`. **Idempotency key = `(import_batch_id, row_number)`** plus the `applied_at`/
  `target_trip_id` guard: a re-run **skips** already-applied rows, so partial failures converge without duplicate trips.
  A `new` row that races to a `23505` on `(customer_id, external_trip_id)` is caught and **re-resolved as update/no-op**.
  An `update` to a trip **past `confirmed`** without `authorizedReview` surfaces `REVIEW_REQUIRED` and the row is marked
  **needs-review** (reported, not silently dropped — FR-024). Counts (`created/updated/duplicate/error`) are tallied to
  the batch; `import.confirm` is audited.
- **Rationale**: STACK §3.11 (idempotent jobs, record progress); FR-027a/FR-029; the partial unique index is the DB-level
  backstop; the per-row `applied_at` flag makes the *job* idempotent on top of it.
- **Alternatives**: one all-or-nothing transaction over the whole batch (rejected — one bad row blocks a good file; retry
  restarts everything; doesn't scale); raw `INSERT … ON CONFLICT` upsert bypassing the domain services (rejected —
  violates FR-028; skips the `original_plan` snapshot, audit, and review-gate logic).

## R9 — Config over code: templates / status mappings / location aliases as Zod-validated DB config

- **Decision**: Store import **templates/column mappings**, **status-label mappings**, and **location aliases** as **DB
  tables** whose payloads are **Zod-validated jsonb**. The Zod schemas defining valid config live in
  `@brazil-tms/shared/schemas/import.ts` and are the **single validation boundary** reused by the web admin UI and the
  worker (which re-validates loaded config to fail loudly on drift). The mapping engine
  (`@brazil-tms/shared/import/engine.ts`) is **pure** and config-driven.
- **Rationale**: Constitution **Principle V** (and STACK §3.4/§3.12/§7) — one shared mapping engine + per-customer
  *configuration*, never per-customer code; onboarding a customer is a config task. Centralizing Zod in `shared` enforces
  DRY and keeps web/worker in lockstep.
- **Alternatives**: per-customer TS config modules / hardcoded mappings (rejected — direct Principle V violation);
  validating config only at write time (rejected — worker must re-validate as defense).

## R10 — Status mapping is record/validate only (import never transitions)

- **Decision**: Every imported trip is created in **`received`**. The **Status Mapping** resolves a customer's status
  label to an internal status **for recording/validation only** — import **does not** drive status transitions from the
  file. Unmapped labels are reported, never guessed.
- **Rationale**: Clarification 2026-05-30; PRD §12 ("Trip imported or manually created" → `received`); slice 003 owns the
  status machine and 006/007 own transitions. Keeps import idempotent and avoids racing the slices that own transitions.
- **Alternatives**: import drives transitions from the file / a "cancelled" label cancels the trip (rejected — pulls
  status-machine driving into import, overlaps 006/007; deferred unless a future slice needs it).

## R11 — Unknown-location resolution: map-to-existing + remembered alias

- **Decision**: A row whose origin/destination does not resolve to an **active** `(customer_id, code)` location is flagged
  `unknown_location` (blocks creation). An authorized user resolves it by **mapping the file value to an existing active
  location**; the `(customer_id, file_value) → location_id` alias is stored in `location_aliases` so future imports
  auto-resolve it. Import **never creates** master-data locations (slice 002 owns that).
- **Rationale**: LANE-005 + Clarification 2026-05-30; keeps location creation out of 004's scope while satisfying
  "flag for mapping"; the remembered alias avoids re-mapping every import.
- **Alternatives**: inline location creation in the import flow (rejected — pulls a 002 surface into import); map without
  remembering (rejected — forces re-mapping every import).

## R12 — Supabase Storage for original file + error report (private, server-mediated)

- **Decision**: First use of **Supabase Storage**. A private bucket holds the **original upload** and the **generated
  error report**; only their storage keys + metadata live in `import_batches`. A new server-only helper
  (`apps/web/lib/supabase/storage.ts`, service-role) does `putOriginal`, `putErrorReport`, and `signedUrl`. Downloads go
  through the BFF (`GET /api/imports/[id]/error-report`) which issues a short-lived signed URL; no public object URLs.
- **Rationale**: STACK §3.9 (binaries in Storage, metadata in Postgres; access follows trip/customer permissions);
  Constitution IV (service-role server-only; gateway not exposed).
- **Alternatives**: store files as Postgres `bytea` (rejected — §3.9); public Storage URLs (rejected — bypasses BFF authz).

## R13 — Permissions, audit, and polling

- **Decision**: **Reuse the existing `import_trips` permission key** (already in `@brazil-tms/shared/auth/permissions.ts`,
  granted to `admin` + `operations_manager`) for all import upload/preview/confirm/config endpoints — **no new key**;
  004 is the first slice to *enforce* it. Add audit actions `import.create`, `import.confirm`, `import_template.create`,
  `import_template.update`, `status_mapping.upsert`, `location_alias.create` to the shared `AuditAction` union (per-trip
  `trip.create`/`trip.plan_update` still fire during confirm). Batch progress is surfaced by **TanStack Query polling**
  of `GET /api/imports/[id]` — **no Realtime**.
- **Rationale**: Constitution I (no key without need — it exists), IV (sensitive actions audited), tech constraints
  (polling-only). 
- **Alternatives**: a new `manage_import_templates` key (rejected — `import_trips` already covers the authorized roles;
  YAGNI); Realtime progress (**excluded**).

## R14 — What is explicitly NOT built (scope guard, Constitution II)

- **Decision**: Out of 004: API ingestion + email-attachment ingestion (`INT-008/009`, Later); trip list/detail/board/
  dashboard (005); dispatch/assignment (006); SLA/events/exceptions (007); documents/billing/export (008); reporting
  (009); inline master-data location creation (002); driving status transitions from the file (006/007). The four §29
  business inputs stay **BLOCKED**: real Shopee/DHL/ML files, per-customer status vocabularies, fuzzy-duplicate tolerance
  values, required-field overrides — built against sample fixtures + documented defaults, labeled scaffolding, **not**
  marked complete.
- **Rationale**: SPEC-SLICING boundaries; Constitution II (gated features not marked complete; defaults labeled).
- **Alternatives**: none — building any of the above is a different slice.
