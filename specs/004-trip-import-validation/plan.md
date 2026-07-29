# Implementation Plan: Trip Import, Templates, Validation, and Duplicate Handling

**Branch**: `004-trip-import-validation` | **Date**: 2026-05-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-trip-import-validation/spec.md`

## Summary

Build the **primary trip-intake path**: Operations selects a customer, uploads a CSV/XLSX of pre-planned trips,
the system maps columns into the internal trip model via a **per-customer template**, validates each row, detects
duplicates, and — on confirmation — **creates or updates trips through the slice-003 shared domain** while recording
a durable **import batch**. The hard rules are **one config-driven import engine, many customer configs** (Constitution V)
and **idempotent matching on `(customer + external trip ID)`** — a repeated external ID is an *update* or *no-op*, never a
blocking duplicate; an ID-less look-alike is a *flagged potential* duplicate (spec §US3, PRD §19.1).

This is the **first slice to activate the worker**: heavy parsing/validation/duplicate-detection runs as **`pg-boss`
jobs on the existing-but-empty `workers/` process** (STACK §3.11/§6.3), never in request handlers. The BFF does only the
fast path — authz, upload the **original file to Supabase Storage** via the server-only service-role client, insert the
batch row, and enqueue. Batch progress is surfaced by **TanStack Query polling** (no Realtime). Customer variation
(templates, status-label mappings, location aliases) is **Zod-validated DB config**, not per-customer code.

Technical approach: 5 new `public` tables (`import_templates`, `import_batches`, `import_rows`, `status_mappings`,
`location_aliases`), 3 new enums, and the activation of the trips `import_batch_id` **forward-hook FK** left by 003. A
pure **mapping engine** in `@brazil-tms/shared` (apply template → mapped row; explicit Luxon date/number normalization)
is reused by both web and worker. The confirm job is **per-row best-effort + idempotent**: it resolves the match, then
**calls 003's `createTrip` / `updateTripPlan`** (it does not re-implement trip writes), links `import_rows.target_trip_id`,
and skips already-applied rows on re-run — with the trips partial unique index `(customer_id, external_trip_id)` as the
concurrency backstop. Reuse, unchanged: 001's `requireAuth`/`requirePermission` (the **existing `import_trips` key**),
`writeAudit`, `handleRouteError`/`Conflict`, the Drizzle client; 002's master-data FKs and uniqueness keys; 003's status
machine, `trip_event_source = 'import'`, and append-only audit. **No new package** (the worker is the sanctioned
one-app-one-worker shape), **no new permission key**.

## Technical Context

**Language/Version**: TypeScript 5.6 (strict); Node.js 20 LTS; pnpm 10 monorepo.

**Primary Dependencies** (existing): Next.js 15 (App Router) + React 19; Drizzle ORM over `postgres` (server-only);
Zod 3.23 (row + config validation, shared by web + worker); `@supabase/supabase-js` service-role client (now also for
**Storage**); Luxon 3 (explicit customer-date normalization → UTC); TanStack Query 5 + Table 8 (Trip Import screen +
polling); `next-intl` (pt-BR). **New**: `pg-boss` (Postgres-backed queue, single worker — STACK-sanctioned, no Redis);
`csv-parse` (streaming CSV) + `exceljs` (XLSX read + error-report write), **worker-only** (the worker is a plain Node
process, not bundled by Next — no `serverExternalPackages` entry needed; never imported by `apps/web`).

**Storage**: self-hosted Supabase Postgres + **Supabase Storage** (first use). **New** `public` tables: `import_templates`,
`import_batches`, `import_rows`, `status_mappings`, `location_aliases`. **New** enums: `import_batch_status`,
`import_row_outcome`, `import_row_match`. **New FK**: `trips.import_batch_id → import_batches.id` (activates 003's
forward hook). Writes to existing `public.audit_logs` (append-only) and, via the reused 003 services, `trips` +
`trip_events` (`source='import'`). Original upload file + generated error report live in a private Storage bucket;
**only their keys/metadata** are in Postgres (STACK §3.9). Access via Drizzle + service-role Storage (server-only);
PostgREST/gateway never exposed.

**Testing**: Vitest is the primary gate. **Pure unit** (`packages/shared`): mapping-engine `applyTemplate`, Luxon
date/number normalization, status-label resolution, in-file-collision detection, config Zod schemas. **Service/worker
integration** (dev DB, `describe.skipIf(!DATABASE_URL)`): upload→batch-row+enqueue; parse→`import_rows` with preserved
`row_number`; validation outcomes (valid/warning/error) incl. unknown-location flag, inactive customer, bad dates;
duplicate semantics — new vs update vs **no-op** (identical re-import → 0 new) vs **potential duplicate** (recorded
reason) vs in-file collision (all error); confirm calls `createTrip`/`updateTripPlan`, is **idempotent on re-run**
(0 duplicate trips), and respects the post-`confirmed` `REVIEW_REQUIRED` gate; import confirmation + trip create/update
are audited. **Playwright**: the Trip Import critical path (select customer/template → upload → preview/validation →
confirm → batch history) and `401/403` on import endpoints.

**Target Platform**: Linux server via Docker Compose (Supabase, **app + worker**, Caddy). Caddy raises the request-body
limit for the upload route (App Router has no per-route body-size knob). Evergreen browsers for the Trip Import screen.

**Project Type**: Web application — existing monorepo (`apps/web` + `packages/{shared,db}` + **`workers/` activated**).
No new package.

**Performance Goals**: Upload returns `202` immediately (fast path: validate + Storage put + 1 insert + enqueue). A
**1,000-row file is parsed, validated, and ready-to-confirm within 5 minutes** (SC-004) via streaming row-by-row worker
processing (bounded memory). Batch progress polled every few seconds (TanStack Query). Trip volumes modest (~1000s/month).

**Constraints**: BFF-only access; service-role key (incl. Storage) server-only; gateway/PostgREST never public; **NO**
Realtime / Edge Functions / Redis-BullMQ / microservices / route optimizer; freshness via polling; heavy work in the
worker (never request handlers); one import engine, customer variation is **config** (no per-customer code); original
plan immutable (via `createTrip`); original file + per-row `raw` preserved; audit append-only (soft-delete/archival,
no hard delete); customer dates normalized **explicitly** (Luxon, no implicit `Date`); UI pt-BR; timestamps UTC
(displayed `America/Sao_Paulo`); money integer centavos BRL.

**Scale/Scope**: 5 new tables; 3 new enums; 1 new FK (forward-hook activation); ~6 new audit actions; **0 new permission
keys** (reuse `import_trips`); the worker **activated** with `pg-boss` + 5 job handlers (parse → validate →
detect-duplicates → generate-error-report, plus user-triggered confirm-import); a server-only Storage helper; ~8 BFF
endpoints; the Trip Import screen + import-batch-history UI; a reusable mapping engine + config Zod in `shared`. **Four
business inputs remain BLOCKED** (real Shopee/DHL/ML files; per-customer status vocabularies; fuzzy-duplicate tolerance
values; required-field overrides) — scaffolded config-driven with documented defaults, **not** invented (Constitution II).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Confirmed against `.specify/memory/constitution.md` (v1.0.0):

- [x] **Simplicity (I)**: The worker is **not a new package** — `workers/` already exists in the workspace and the
  constitution's declared deployable shape is "one app + **one worker**"; 004 activates it because heavy import work
  MUST leave the request path (STACK §2/§6.3), not as speculative complexity. `pg-boss` is **one** dependency that
  reuses the same Postgres (no Redis/broker). The **mapping engine is the legitimately-justified abstraction**: column
  parsing repeats across ≥3 customers (Shopee/DHL/ML) with identical logic differing only by *config* (≥3 rule, Principle
  V) — the alternative (per-customer code) is the prohibited one. Five tables are the minimal durable model (batch +
  rows for traceability/idempotency + 3 config tables); `import_rows` is one staging table, not a speculative engine.
  No new permission key (reuse `import_trips`). **No abstraction added below the ≥3 threshold.**
- [x] **Scope (II)**: Within slice 004 per `docs/SPEC-SLICING.md`. Out-of-scope surfaces (trip list/detail/board 005,
  dispatch 006, SLA/events 007, documents/billing 008, reports 009; API & email ingestion `INT-008/009`) are not built.
  The four PRD §29-gated inputs are **labeled config-driven scaffolding with documented defaults** and **not** marked
  complete — final customer-template sign-off stays **BLOCKED**.
- [x] **System-of-record (III)**: Postgres owns batches/rows; the **original file** (Storage) and **per-row `raw`**
  (immutable once written) are preserved; the immutable original plan is captured by 003's `createTrip` (not re-done
  here); status is the reused enumerated machine (import lands trips in `received`, never transitions from the file);
  `audit_logs` append-only; import confirmation + every trip create/update audited; no hard delete (templates/aliases
  archive via nullable `archived_at`).
- [x] **Authz & secrets (IV)**: Every surface goes through the BFF; upload/preview/confirm/config endpoints gate on
  `requirePermission(ctx, 'import_trips')`. The service-role key (Postgres **and** Storage) is server/worker-only; the
  Supabase gateway is never exposed; Storage objects are private (server-issued signed URLs only). Imports, template
  changes, status-mapping changes, location-alias creation, and confirmation are audited.
- [x] **Config over code (V)**: Import templates/column mappings, status-label mappings, and location aliases are
  **DB tables with Zod-validated config** (schemas in `@brazil-tms/shared`, reused by web + worker). **One shared mapping
  engine, no per-customer importer** — onboarding a customer is a config task.
- [x] **Tech constraints**: self-hosted Supabase (Postgres/Auth/**Storage**); `pg-boss` Postgres-backed queue + the
  single worker; polling-only freshness. NO Realtime, NO Edge Functions, NO Redis/BullMQ, NO microservices, NO route
  optimizer.
- [x] **Workflow**: feature branch `004-trip-import-validation` → PR to `dev`; CI gates (lint/typecheck/build/tests)
  green; PR template (incl. migration + Storage-bucket/env notes); AI does not merge to `main`.

**Result: PASS.** No violations; **Complexity Tracking is therefore empty.** (The worker activation, `pg-boss`, and
Storage are STACK-mandated infrastructure for this slice, not constitutional deviations.)

## Project Structure

### Documentation (this feature)

```text
specs/004-trip-import-validation/
├── plan.md                       # This file (/speckit-plan output)
├── research.md                   # Phase 0 — design decisions (R0–R13)
├── data-model.md                 # Phase 1 — tables, enums, staging model, lifecycle, audit, validation, config
├── quickstart.md                 # Phase 1 — install deps, migrate, run worker, exercise, test, quality gate
├── contracts/
│   ├── bff-endpoints.md          # Import + config HTTP surface (upload, preview, confirm, batches, config, error report)
│   ├── import-engine-api.md      # NEW reusable engine/service API + the consume-003 reuse contract
│   └── permission-matrix.md      # Reuse of `import_trips` (first ENFORCED in 004) + matrix row + invariants
├── spec.md                       # Feature spec (/speckit-specify + /speckit-clarify)
├── checklists/requirements.md    # Spec quality checklist
└── tasks.md                      # Phase 2 — /speckit-tasks (NOT created by /speckit-plan)
```

### Source Code (repository root) — extends the existing monorepo

```text
packages/db/
├── schema/
│   ├── enums.ts                  # EXTEND: + import_batch_status, import_row_outcome, import_row_match
│   ├── import-templates.ts       # NEW: import_templates (per-customer config: mappings, parsing rules, overrides)
│   ├── import-batches.ts         # NEW: import_batches (file/storage key, uploader, counts, status, error-report key)
│   ├── import-rows.ts            # NEW: import_rows (row_number, raw, mapped, outcome, reasons, match, target_trip_id)
│   ├── status-mappings.ts        # NEW: status_mappings (customer label → internal trip_status)
│   ├── location-aliases.ts       # NEW: location_aliases (customer file value → existing location)
│   ├── trips.ts                  # EXTEND: add the FK trips.import_batch_id → import_batches(id) (003 forward hook)
│   └── index.ts                  # EXTEND: export the 5 new schema files
├── src/                          # PROMOTE 003's trip-write path so BOTH web and worker can call it (R2; FR-027/FR-028 reuse)
│   ├── trips/                    #   MOVED from apps/web/lib/trips: createTrip/updateTripPlan/transitionTripStatus/cancelTrip
│   │                             #   + reads (getTrip/listTrips) + trip-dto.ts (TripDetail/loadTripDetail/toTripSummary); keep `server-only` (never client-imported)
│   ├── audit/write-audit.ts      #   MOVED from apps/web/lib/audit: writeAudit (shared by web + worker)
│   └── errors.ts                 #   MOVED: framework-free `Conflict` + typed errors ONLY (handleRouteError/apiError STAY in apps/web; respond.ts re-exports Conflict)
├── migrations/                   # drizzle-kit generate output + manual ADD FK on trips.import_batch_id
└── seed/
    └── import-sample.ts          # NEW (+ add `db:seed:import` script to packages/db/package.json): default template/status-mapping scaffolding + fixtures (labeled)

packages/shared/src/
├── import/
│   ├── engine.ts                 # NEW: applyTemplate(rawRow, template) → mapped row (pure); column-mapping resolution
│   ├── normalize.ts              # NEW: Luxon date + number normalization per parsing rules (pure; no implicit Date)
│   ├── matching.ts               # NEW: in-file collision detection + fuzzy-key builder (pure)
│   └── index.ts                  # NEW: barrel
├── schemas/
│   └── import.ts                 # NEW: Zod — templateConfig, statusMapping, locationAlias, uploadMeta, mappedRow
├── audit/actions.ts              # EXTEND: + import.create | import.confirm | import_template.create|update |
│                                 #          status_mapping.upsert | location_alias.create
├── auth/permissions.ts           # (NO CHANGE — reuse existing 'import_trips'; documented in permission-matrix.md)
└── index.ts                      # EXTEND: export ./import, ./schemas/import

apps/web/
├── lib/
│   ├── trips/*                   # EXTEND: thin RE-EXPORTS of the promoted @brazil-tms/db trip services (003 callers/tests keep working)
│   ├── audit/write-audit.ts      # EXTEND: thin RE-EXPORT of @brazil-tms/db writeAudit
│   ├── api/respond.ts            # EXTEND: re-export Conflict from @brazil-tms/db; keep handleRouteError mapping
│   ├── supabase/storage.ts       # NEW: server-only Storage helper (service-role): putOriginal, putErrorReport, signedUrl
│   └── imports/
│       ├── import-batches-service.ts   # NEW: createBatch(upload+enqueue), getBatch(status+counts), listBatches, confirmBatch(enqueue)
│       ├── import-rows-service.ts       # NEW: listRows(batch) for the preview/validation table
│       ├── import-templates-service.ts  # NEW: CRUD per-customer template config (Zod-validated)
│       ├── status-mappings-service.ts   # NEW: upsert/list customer status-label mappings
│       ├── location-aliases-service.ts  # NEW: resolve unknown location → alias (map-to-existing; remembered)
│       └── *.test.ts                    # NEW: Vitest integration (dev DB)
└── app/
    ├── api/
    │   ├── imports/
    │   │   ├── route.ts          # NEW: POST upload (formData → Storage + batch + enqueue → 202); GET list batches
    │   │   └── [id]/
    │   │       ├── route.ts          # NEW: GET batch status + counts (polled)
    │   │       ├── rows/route.ts      # NEW: GET preview/validation rows
    │   │       ├── confirm/route.ts   # NEW: POST confirm → enqueue confirm-import (idempotent)
    │   │       ├── error-report/route.ts  # NEW: GET server-issued signed download URL
    │   │       └── locations/route.ts     # NEW: POST resolve unknown location (create alias)
    │   └── import-templates/
    │       ├── route.ts          # NEW: GET list / POST create template config
    │       └── [id]/route.ts     # NEW: GET / PATCH / archive; nested status-mappings managed here or under customer
    └── (shell)/imports/          # NEW: Trip Import screen + import-batch-history (the existing authenticated route group hosting 002's master-data screens)
        ├── page.tsx              #   customer selector · template selector · file upload · preview/validation table · duplicate warnings · confirm
        └── history/page.tsx      #   import batch history (file, user, time, customer, counts, status, error-report link)

workers/                          # ACTIVATE the existing stub (one app + one worker)
├── package.json                 # EXTEND: + pg-boss, csv-parse, exceljs, luxon, @brazil-tms/{db,shared}, postgres; scripts start/dev/typecheck/test
├── index.ts                     # NEW: boot pg-boss (create schema, start, register handlers), graceful shutdown
├── lib/
│   ├── queue.ts                 # NEW: pg-boss bootstrap + typed enqueue helpers (job names + Zod payloads from shared)
│   └── batch-progress.ts        # NEW: durable batch status/counter updates
├── jobs/
│   ├── parse/index.ts           # NEW: download original from Storage → stream-parse (csv-parse/exceljs) → import_rows (raw+mapped) → enqueue validate
│   ├── validate/index.ts        # NEW: per-row validation (customer/location/lane/dates/vehicle/required) → outcome+reasons → enqueue detect-duplicates
│   ├── detect-duplicates/index.ts  # NEW: match (customer+external id): new/update/no_op; fuzzy → potential_duplicate; in-file collision → error → status validated
│   ├── generate-error-report/index.ts  # NEW: write error CSV/XLSX → Storage → set error_report key
│   ├── confirm-import/index.ts  # NEW: per-row best-effort+idempotent; CALL 003 createTrip/updateTripPlan; link target_trip_id; audit import.confirm
│   └── *.test.ts                # NEW: Vitest integration for parse/validate/dedup/confirm
└── tsconfig.json                # NEW (if missing): worker TS config

vitest.workspace.ts              # EXTEND: + a `workers` project (env node, include workers/**/*.test.ts)
infra/                           # EXTEND: docker-compose adds the worker service; Caddy upload body-size limit
```

**Structure Decision**: Web application on the existing monorepo. **No new package** (Constitution I): the worker uses the
pre-existing `workers/` workspace member (the sanctioned one-app-one-worker shape), the mapping engine + config Zod live
in `@brazil-tms/shared` (reused by web **and** worker, mirroring how 003's domain lives in `shared`), persistence in
`packages/db/schema/*`, BFF enforcement in `apps/web/lib/imports/*` + `apps/web/app/api/imports/*`, and the long-running
parse/validate/dedup/confirm logic in `workers/jobs/*`. The confirm job **calls** 003's `apps/web/lib/trips/*` domain
services for every trip write rather than touching `trips` directly (FR-027/FR-028 reuse contract) — implemented as a
shared trip-write path importable by the worker (see `contracts/import-engine-api.md`).

## Complexity Tracking

> No Constitution Check violations. The worker (existing workspace member), `pg-boss` (Postgres-backed, no broker), and
> Supabase Storage are STACK-mandated infrastructure for moving heavy import work off the request path — not new packages
> or abstractions below the ≥3 threshold. No new permission key (reuse `import_trips`). This section is intentionally empty.
