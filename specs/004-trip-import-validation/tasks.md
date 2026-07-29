---
description: "Task list for 004 — Trip Import, Templates, Validation, and Duplicate Handling"
---

# Tasks: Trip Import, Templates, Validation, and Duplicate Handling

**Input**: Design documents from `specs/004-trip-import-validation/`

**Prerequisites**: plan.md, spec.md, research.md (R0–R14), data-model.md, contracts/ (bff-endpoints.md,
import-engine-api.md, permission-matrix.md), quickstart.md

**Tests**: INCLUDED. STACK §3.13 + the constitution make **import validation, duplicate detection, confirm
idempotency, and permission checks** the primary Vitest gate, with a **Playwright** critical-path check on the Trip
Import screen + import endpoint authz. Test tasks are first-class below.

**Organization**: Tasks are grouped by the six user stories from spec.md. This feature is the **first slice to activate
the worker** (`pg-boss`, the existing `workers/` member) and **first use of Supabase Storage**. It **reuses, never
redefines**: 001's `requireAuth`/`requirePermission` + the existing **`import_trips`** key, `writeAudit`,
`handleRouteError`/`Conflict`, the Drizzle `db`; 002's `customers.customer_code` / `locations (customer_id, code)` /
`lanes` and the `vehicle_type` enum; 003's status machine, `trip_event_source='import'`, append-only audit, and the
trip-write services (`createTrip`/`updateTripPlan`) — **promoted into `@brazil-tms/db`** (R2) so the worker can call
them. One config-driven engine; customer variation is Zod-validated DB config. Four §29 inputs stay **BLOCKED**
(documented-default scaffolding).

## Format: `[ID] [P?] [Story] Description with file path`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1–US6 (story-phase tasks only); Setup/Foundational/Polish carry no story label

## Path conventions

Monorepo: `packages/db/` (Drizzle schema + migrations + **promoted trip-write services in `src/`**),
`packages/shared/src/` (mapping engine + Zod config + audit/permissions), `apps/web/` (BFF route handlers, services,
Trip Import UI, e2e), `workers/` (pg-boss entrypoint + `jobs/*`). Import access = **`import_trips`** (Admin, Ops Manager).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the running 001/002/003 stack, provision Storage, and create this feature's source folders + worker deps.

- [X] T001 Verify the dev stack per quickstart.md (`pnpm install`; `docker compose -f infra/supabase/docker-compose.yml up -d`; `pnpm --filter @brazil-tms/db db:migrate` for 001+002+003; `pnpm --filter @brazil-tms/db db:seed`; `db:seed:master-data` to anchor imports; `pnpm dev` boots :3000), then create a **private** Supabase Storage bucket `imports` and set env `IMPORT_BUCKET=imports` (app + worker) alongside `SUPABASE_SERVICE_ROLE_KEY` / `NEXT_PUBLIC_SUPABASE_URL` / `DATABASE_URL`
- [X] T002 [P] Create feature source folders: `apps/web/lib/imports/`, `apps/web/app/api/imports/`, `apps/web/app/api/import-templates/`, `packages/shared/src/import/`, `workers/jobs/`, `workers/lib/`
- [X] T003 [P] Activate the worker package: extend `workers/package.json` with deps `pg-boss`, `csv-parse`, `exceljs`, `luxon`, `@brazil-tms/db`, `@brazil-tms/shared`, `postgres`, and scripts `start` (`tsx index.ts`), `dev` (`tsx watch index.ts`), `typecheck`, `test`; add `workers/tsconfig.json` (extends the repo TS base, `module`/`moduleResolution` matching the monorepo)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared infrastructure every story needs — the 5 tables + 3 enums + the `trips.import_batch_id` FK in
one migration; the **R2 promotion** of 003's trip-write path into `@brazil-tms/db`; the pure mapping engine + Zod config
in `shared`; the new audit actions; the `import_trips` invariants; the Storage helper; and the pg-boss worker bootstrap.

**⚠️ CRITICAL**: No user-story work can begin until this phase is complete.

### Database (packages/db/schema)

- [X] T004 Extend `packages/db/schema/enums.ts` with pgEnums `import_batch_status` (`received,parsing,validating,validated,confirming,completed,failed`), `import_row_outcome` (`valid,warning,error`), `import_row_match` (`new,update,no_op,potential_duplicate,unresolved`) per data-model.md → Enums
- [X] T005 [P] Create `packages/db/schema/import-templates.ts` (`import_templates` per data-model §1: FK `customer_id`→customers; `name`, `version` default 1, `file_type` CHECK in (`csv`,`xlsx`), `column_mappings`/`parsing_rules`/`required_overrides` jsonb, `active`, `archived_at`; UNIQUE `(customer_id, name, version)`)
- [X] T006 [P] Create `packages/db/schema/import-batches.ts` (`import_batches` per data-model §2: FK `customer_id`→customers, nullable `template_id`→import_templates, FK `uploaded_by`→users; `file_name`, `storage_key`, `status import_batch_status NOT NULL DEFAULT 'received'`, `total_rows`+4 count columns, `error_report_storage_key`, `error_message`; customer + created indexes) — depends on T004, T005
- [X] T007 [P] Create `packages/db/schema/import-rows.ts` (`import_rows` per data-model §3: FK `import_batch_id`→import_batches ON DELETE CASCADE, nullable FK `target_trip_id`→trips; `row_number`, `raw` jsonb NOT NULL, `mapped` jsonb, `outcome import_row_outcome`, `reasons` jsonb default `[]`, `match_decision import_row_match`, `applied_at`; UNIQUE `(import_batch_id, row_number)`; `(import_batch_id, outcome)` index) — depends on T004, T006
- [X] T008 [P] Create `packages/db/schema/status-mappings.ts` (`status_mappings` per data-model §4: FK `customer_id`→customers; `customer_label`, `internal_status trip_status` (existing 003 enum), `active`, `archived_at`; UNIQUE `(customer_id, customer_label)`)
- [X] T009 [P] Create `packages/db/schema/location-aliases.ts` (`location_aliases` per data-model §5: FK `customer_id`→customers, FK `location_id`→locations, FK `created_by`→users; `file_value`; UNIQUE `(customer_id, file_value)`)
- [X] T010 Export the 5 new tables from `packages/db/schema/index.ts` — depends on T005–T009
- [X] T011 Generate the migration: `pnpm --filter @brazil-tms/db db:generate`; review SQL in `packages/db/migrations/` (public schema only; confirm the 3 enums, the 5 tables, FKs, CHECK, UNIQUEs, indexes) — depends on T010
- [X] T012 Hand-append the cross-feature FK to the generated migration SQL (drizzle-kit won't infer 003's forward hook): `ALTER TABLE public.trips ADD CONSTRAINT trips_import_batch_id_fk FOREIGN KEY (import_batch_id) REFERENCES public.import_batches(id);` (data-model §6) — depends on T011
- [X] T013 Apply the migration: `pnpm --filter @brazil-tms/db db:migrate`; verify the 5 tables + 3 enums exist and the `trips.import_batch_id` FK is in effect — depends on T012

### Reuse promotion — trip-write path into `@brazil-tms/db` (R2; FR-027/FR-028)

- [X] T014 [P] Promote 003's trip-write path so the worker can call it: move `createTrip`/`updateTripPlan`/`transitionTripStatus`/`cancelTrip` + reads `getTrip`/`listTrips` + `trip-dto.ts` (`TripDetail`/`loadTripDetail`/`toTripSummary`) from `apps/web/lib/trips/*` into `packages/db/src/trips/*`; move `writeAudit` into `packages/db/src/audit/write-audit.ts`; move the **framework-free** `Conflict` + typed business errors into `packages/db/src/errors.ts`; keep the `server-only` guard; export from `packages/db/src/index.ts`
- [X] T015 Re-export for back-compat (no behavior change): `apps/web/lib/trips/*` re-export the promoted services from `@brazil-tms/db`; `apps/web/lib/audit/write-audit.ts` re-exports `writeAudit`; `apps/web/lib/api/respond.ts` re-exports `Conflict` from `@brazil-tms/db` and **keeps** `handleRouteError`/`apiError` (Next-coupled, stays in web) — depends on T014
- [X] T016 Verify the promotion is parity-only: run `pnpm --filter @brazil-tms/db test`, `pnpm exec vitest run --project web` (003 trip-service tests), and the 003 inspector e2e — all green via the re-exports; the worker can `import { createTrip, updateTripPlan } from "@brazil-tms/db"` without pulling `next/server` — depends on T013, T015

### Shared engine, config, audit, permissions (packages/shared)

- [X] T017 [P] Create the pure mapping engine `packages/shared/src/import/{engine,normalize,matching,index}.ts`: `applyTemplate(rawRow, template)→MappedRow` (config-driven, no per-customer code); `normalizeDate`/`normalizeNumber` (explicit **Luxon** per parsing rules — no implicit `Date`, STACK §3.5); `buildFuzzyKey(row)` + `detectInFileCollisions(rows)` (contracts/import-engine-api.md §B)
- [X] T018 Create `packages/shared/src/schemas/import.ts` (Zod `TemplateConfig`, `UploadMeta`, `MappedRow` per contracts §B); export `./import` and `./schemas/import` from `packages/shared/src/index.ts` (shares `index.ts` with T017's export — serialize) — depends on T017
- [X] T019 [P] Vitest `packages/shared/src/import/engine.test.ts`: `applyTemplate` maps source→internal fields per config; `normalizeDate` parses an explicit format+zone to UTC and **rejects** implicit/ambiguous input; `normalizeNumber` honors decimal/thousand separators; `detectInFileCollisions` returns the row_numbers sharing `(customer, external_trip_id)`; `TemplateConfig` accepts a valid config and rejects an empty `columnMappings` — depends on T017, T018
- [X] T020 [P] Extend the `AuditAction` union in `packages/shared/src/audit/actions.ts` with `'import.create' | 'import.confirm' | 'import_template.create' | 'import_template.update' | 'status_mapping.upsert' | 'location_alias.create'` (data-model.md → Audit actions)
- [X] T021 [P] Add `import_trips` invariants to `packages/shared/src/auth/permissions.test.ts` (**no key change** — it already exists): `can('admin','import_trips')` ✓, `can('operations_manager','import_trips')` ✓, dispatcher/control_tower/finance/executive_viewer ✗ (contracts/permission-matrix.md)

### Storage + worker bootstrap

- [X] T022 [P] Create the server-only Storage helper `apps/web/lib/supabase/storage.ts` (service-role client `.storage`): `putOriginal(batchId, bytes)`, `putErrorReport(batchId, bytes)`, `signedUrl(key, ttl)` against the `IMPORT_BUCKET` private bucket; never expose public URLs (R12, Constitution IV)
- [X] T023 Create the worker entrypoint `workers/index.ts` (boot `pg-boss`: create schema, `start()`, register the import job handlers **as implemented** — parse/validate/detect-duplicates/confirm-import in US1, generate-error-report added in US2 — graceful shutdown) + `workers/lib/queue.ts` (typed enqueue helpers, job-name constants, Zod payloads from `@brazil-tms/shared`) + `workers/lib/batch-progress.ts` (durable `import_batches` status/counter updates) — depends on T003, T013
- [X] T024 [P] Extend `vitest.workspace.ts` with a `workers` project (env node, include `workers/**/*.test.ts`, alias `@brazil-tms/*` like the other projects)

**Checkpoint**: Schema migrated (incl. the trips FK), trip-write services promoted + re-exported (003 green), engine +
Zod config + audit actions + Storage helper + pg-boss worker ready — stories can begin.

---

## Phase 3: User Story 1 — Import new trips from a customer file (Priority: P1) 🎯 MVP

**Goal**: Select customer + template, upload a CSV/XLSX, the pipeline parses → validates → matches → and on confirm
**creates trips in Received through the promoted domain services**, recording a durable import batch. (INT-001/002/003/004;
FR-001..FR-009, FR-016, FR-027, FR-027a, FR-029.)

**Independent Test**: Configure a template, upload a clean fixture → batch moves `received→…→validated` (polled), preview
shows per-row status + summary; confirm → trips created in **Received**, each linked to the batch; re-running confirm
creates **0** duplicate trips (idempotent).

### Config the import needs

- [X] T025 [P] [US1] Implement `apps/web/lib/imports/import-templates-service.ts` (`createTemplate`/`getTemplate`/`updateTemplate(archive?)`; Zod `TemplateConfig`; `isUniqueViolation`→`Conflict('DUPLICATE_TEMPLATE')`; audit `import_template.create`/`import_template.update`) — depends on T016, T018, T020
- [X] T026 [P] [US1] Implement `apps/web/app/api/import-templates/route.ts` (GET list `?customerId`/`?includeArchived`; POST create) + `apps/web/app/api/import-templates/[id]/route.ts` (GET/PATCH/archive); `requirePermission(ctx,'import_trips')`; `handleRouteError` — depends on T025
- [X] T027 [P] [US1] Implement `apps/web/lib/imports/status-mappings-service.ts` (`upsertStatusMapping`/`listStatusMappings`; reject unknown `internalStatus`; audit `status_mapping.upsert`) + `apps/web/app/api/status-mappings/route.ts` (GET `?customerId`, POST upsert) — depends on T016, T018, T020

### Upload (fast BFF path)

- [X] T028 [US1] Implement `apps/web/lib/imports/import-batches-service.ts` (`createBatch`: validate `UploadMeta` + file type, `storage.putOriginal`, insert `import_batches` status `received`, audit `import.create`, `enqueue('import.parse', {batchId, storageKey})`; `getBatch`; `listBatches`) — depends on T013, T022, T023, T018, T020
- [X] T029 [US1] Implement `apps/web/app/api/imports/route.ts` POST (read `request.formData()`, call `createBatch` → `202 {id}`; `413` guidance is at Caddy) + GET `apps/web/app/api/imports/[id]/route.ts` (batch status + counts, the polled endpoint) — depends on T028

### Worker pipeline (parse → validate → match → confirm)

- [X] T030 [US1] Implement `workers/jobs/parse/index.ts` (`import.parse`: download original via Storage helper; **stream-parse** with `csv-parse`/`exceljs`; `applyTemplate` per row → insert `import_rows` (raw + mapped, **preserve `row_number`**); set `total_rows`; status `parsing`; `enqueue('import.validate')`) — depends on T023, T017, T022
- [X] T031 [US1] Implement `workers/jobs/validate/index.ts` (`import.validate`: per-row validation — customer active; `external_trip_id` present; origin/destination resolve to active `(customer, code)` location else `unknown_location`; **origin ≠ destination**; pickup/delivery windows valid & ordered; `planned_vehicle_type` maps to the `vehicle_type` enum; **planned distance/transit time plausible when provided** (a `warning`-level heuristic with a documented bound — never an `error` gate); required + overrides present; **no conflict with an already-accepted customer update** (FR-011) — set `outcome`+localized `reasons`; status `validating`; `enqueue('import.detect-duplicates')`) — depends on T030, T017
- [X] T032 [US1] Implement `workers/jobs/detect-duplicates/index.ts` (`import.detect-duplicates`: **core match** on `(customer_id, external_trip_id)` → `new` / `update` / `no_op`; tally `created/updated`/`error` counts; set status `validated`) — fuzzy + in-file collision (US3) and the `generate-error-report` enqueue (US2) are added later — depends on T031
- [X] T033 [US1] Implement `workers/jobs/confirm-import/index.ts` (`import.confirm`: iterate `import_rows` with `outcome ∈ {valid,warning}` and `applied_at IS NULL`; per row in one tx **call promoted `createTrip` (new) / `updateTripPlan` (update) / link only (no_op)**, set `target_trip_id`+`applied_at`; catch `(customer_id, external_trip_id)` `23505` race → re-resolve as update/no-op; tally counts; status `confirming→completed`; audit `import.confirm`) — depends on T032, T014
- [X] T034 [US1] Implement `confirmBatch` in `apps/web/lib/imports/import-batches-service.ts` (`enqueue('import.confirm', {batchId, actorUserId})`; audit `import.confirm`; `Conflict('NOT_CONFIRMABLE')` unless status `validated`/`completed`) + `apps/web/app/api/imports/[id]/confirm/route.ts` POST → `202` — depends on T028, T033

### Preview + UI

- [X] T035 [P] [US1] Implement `apps/web/lib/imports/import-rows-service.ts` (`listRows(batchId, {outcome?, match?, limit?, offset?})`) + `apps/web/app/api/imports/[id]/rows/route.ts` GET (preview/validation table) — depends on T013
- [X] T036 [US1] Build the Trip Import screen `apps/web/app/(shell)/imports/page.tsx` (customer selector, template selector, file upload, preview/validation table, the new/updated/duplicate/error summary, confirm) with **TanStack Query polling** of `GET /api/imports/[id]`; pt-BR strings in `apps/web/messages/pt-BR.json` (no Realtime) — depends on T029, T034, T035, T026

### Tests for User Story 1

- [X] T037 [P] [US1] Vitest integration (web) `apps/web/lib/imports/import-batches-service.test.ts` (upload → batch row inserted `received` + `import.create` audit + a `parse` job enqueued; `getBatch` returns counts; `confirmBatch` rejects when not confirmable) — depends on T028, T034
- [X] T038 [P] [US1] Vitest integration (workers) `workers/jobs/parse/parse.test.ts` (a CSV and an XLSX fixture each parse to `import_rows` with **preserved 1-based `row_number`** and mapped fields; `total_rows` set; an **empty/header-only** file → `total_rows=0`, nothing created; a **corrupt/wrong-type** file → batch `failed` with `error_message`, original file retained — spec §Edge Cases) — depends on T030
- [X] T039 [US1] Vitest integration (workers) `workers/jobs/confirm-import/confirm.test.ts` (clean file → trips created in **`received`** linked to `import_batch_id`; **re-run confirm → 0 new trips** (idempotent, SC-002/SC-010); created/updated counts correct) — depends on T033
- [X] T040 [US1] Playwright e2e `apps/web/e2e/trip-import.spec.ts` (select customer + template → upload clean fixture → preview/validation appears → confirm → trips created; **no session → 401**, non-`import_trips` role → **403** on the import endpoints) — depends on T029, T034, T036

**Checkpoint**: A customer file can be uploaded, mapped, validated, previewed, and confirmed into Received trips with a
durable batch — the MVP, independently testable.

---

## Phase 4: User Story 2 — Validate rows, surface errors, export & resolve (Priority: P1)

**Goal**: Per-row Valid/Warning/Error with clear pt-BR messages; export an error report (signed URL); Error rows excluded
on confirm; correct + re-import clears them. (§11.2; INT-006; FR-011..FR-016.)

**Independent Test**: Upload a file with bad rows → each classified with a localized reason; export the error report;
confirm applies only Valid+Warning; fix + re-import → previously failed rows pass.

- [X] T041 [US2] Implement `workers/jobs/generate-error-report/index.ts` (`import.generate-error-report`: write the failed rows + `reasons` + original `row_number` to a CSV/XLSX via `exceljs`; `storage.putErrorReport`; set `import_batches.error_report_storage_key`); **register the handler in `workers/index.ts`** and **wire `workers/jobs/detect-duplicates/index.ts` to `enqueue('import.generate-error-report')` when `error_count>0`** — depends on T031, T032, T022
- [X] T042 [US2] Implement `errorReportUrl` in `apps/web/lib/imports/import-batches-service.ts` (signed URL via Storage helper) + `apps/web/app/api/imports/[id]/error-report/route.ts` GET (`200 {url}` / `404` when none) — depends on T028, T041
- [X] T043 [US2] Extend the Trip Import screen `apps/web/app/(shell)/imports/page.tsx` to render validation results + duplicate warnings per row, an **error-export** button, and a resolve/re-import affordance (pt-BR) — depends on T036, T042
- [X] T044 [US2] Vitest integration (workers) `workers/jobs/validate/validate.test.ts` (rows classified `valid`/`warning`/`error` with localized `reasons` for: missing required field, inactive customer, invalid/unordered windows, unmappable vehicle type; **error rows excluded on confirm**; error report generated + downloadable; a corrected re-import clears the error) — depends on T031, T041, T033

**Checkpoint**: The validation + error-resolution loop works end-to-end on top of US1.

---

## Phase 5: User Story 3 — Duplicate detection & update / no-op semantics (Priority: P2)

**Goal**: Repeated `(customer + external trip ID)` → update or no-op (never blocking); id-less look-alike → flagged
potential duplicate (recorded reason); same-id-twice-in-a-file → all error. (INT-005; §19.1; FR-017..FR-024.)

**Independent Test**: Re-import identical file → all no-op, 0 new; re-import with a changed plan field on a known external
id → update (original preserved, audited); id-less look-alike → potential_duplicate needing a reason; two same-id rows in
one file → both error, none created; update past `confirmed` without review → reported needs-review.

- [X] T045 [US3] Extend `workers/jobs/detect-duplicates/index.ts`: add **fuzzy** matching (`buildFuzzyKey` + a **configurable tolerance with a documented default** — BLOCKED final values) → `potential_duplicate` (`outcome=warning`); `detectInFileCollisions` → all colliding rows `outcome=error` (`reasons: IN_FILE_COLLISION`); tally `duplicate_count` (FR-022, FR-017a, FR-023) — depends on T032, T017
- [X] T046 [US3] Extend `workers/jobs/confirm-import/index.ts`: a `potential_duplicate` row is created only with a **recorded reason**; an `update` to a trip **past `confirmed`** without `authorizedReview` → `REVIEW_REQUIRED` → mark the row **needs-review** (reported, not dropped — FR-024) — depends on T033, T045
- [X] T047 [US3] Vitest integration (workers) `workers/jobs/detect-duplicates/duplicates.test.ts` (identical re-import → all `no_op`, **0 new** (SC-002); changed plan field on known external id → `update`, `original_plan` preserved + `trip.plan_update` audit; id-less look-alike → `potential_duplicate` (created only with recorded reason, SC-006); two same-id rows in one file → both `error`, none created (FR-017a); repeat external id is **never** a blocking duplicate; update past `confirmed` w/o review → needs-review) — depends on T045, T046

**Checkpoint**: Idempotent matching with update/no-op + fuzzy flag + in-file collision verified.

---

## Phase 6: User Story 4 — Flag unknown locations for mapping (Priority: P2)

**Goal**: An origin/destination not resolving to an active `(customer, code)` location is flagged `unknown_location`
(blocks); an authorized user maps it to an **existing** location and the alias is remembered. (LANE-005; FR-025, FR-026.)

**Independent Test**: Upload a row with an unknown origin → flagged (not auto-created/dropped); map it to an existing
location → re-validate → row resolves; next import auto-resolves via the alias; mapping to an archived/other-customer
location → `INVALID_LOCATION_REFERENCE`.

- [X] T048 [US4] Extend `workers/jobs/validate/index.ts` location resolution to also consult `location_aliases` (`(customer_id, file_value)`) before flagging `unknown_location`; on alias hit, resolve to the mapped `location_id` — depends on T031, T013
- [X] T049 [US4] Implement `apps/web/lib/imports/location-aliases-service.ts` (`resolveLocation(batchId, {fileValue, locationId})`: assert the location is active and same-customer via 002's reference check else `Conflict('INVALID_LOCATION_REFERENCE')`; insert `location_aliases`; audit `location_alias.create`; `enqueue('import.validate')` to re-validate affected rows) + `apps/web/app/api/imports/[id]/locations/route.ts` POST — depends on T013, T020, T048
- [X] T050 [US4] Extend the Trip Import screen `apps/web/app/(shell)/imports/page.tsx` with the unknown-location flag + a map-to-existing-location affordance (pt-BR) — depends on T043, T049
- [X] T051 [US4] Vitest integration (web/workers) `apps/web/lib/imports/location-aliases-service.test.ts` (unknown origin → `unknown_location`, **never** auto-created or dropped, SC-005; resolve to existing → re-validate → row resolves; alias remembered → subsequent import auto-resolves; map to archived/other-customer location → `INVALID_LOCATION_REFERENCE`) — depends on T048, T049

**Checkpoint**: Unknown-location flag-and-map loop works, with remembered aliases.

---

## Phase 7: User Story 5 — Review import batch history (Priority: P3)

**Goal**: List every batch (file, user, time, customer, counts, status) with access to the error report and original
file. (INT-004; FR-031.)

**Independent Test**: Run several imports → each appears in history with correct metadata + counts; original file +
per-row `raw` + error report retrievable.

- [X] T052 [US5] Implement `apps/web/app/api/imports/route.ts` GET list (batch history; `?customerId`/`?status`/`?limit`; newest first) reusing `listBatches` — depends on T028
- [X] T053 [US5] Build the import-batch-history screen `apps/web/app/(shell)/imports/history/page.tsx` (TanStack Table: file, user, time, customer, counts, status; error-report download link) (pt-BR) — depends on T052, T042
- [X] T054 [US5] Vitest/e2e `apps/web/e2e/import-history.spec.ts` (after imports, history lists each batch with metadata + the four counts + status; original file + per-row `raw` retrievable; SC-001, SC-007) — depends on T052, T053

**Checkpoint**: Batch history + traceability verified.

---

## Phase 8: User Story 6 — Manually create a trip for exceptions (Priority: P3)

**Goal**: Create a single trip manually (Received, audited, no batch) via the promoted domain service; same
match/update/no-op semantics if an external id is supplied. (INT-007.)

**Independent Test**: Manual create with required fields → trip in **Received** + audit, `import_batch_id` null; manual
create with an existing external id → update/no-op semantics apply.

- [X] T055 [US6] Implement the manual-create surface `apps/web/app/api/trips/route.ts` POST (`requirePermission(ctx,'import_trips')`; validate `createTripSchema`; call promoted `createTrip` with `importBatchId=null`; on an existing `(customer, external_trip_id)` apply the same match → `updateTripPlan`/no-op as the import path) + a minimal manual-entry form on `apps/web/app/(shell)/imports/page.tsx` (pt-BR) — depends on T014, T032
- [X] T056 [US6] Vitest/e2e `apps/web/lib/imports/manual-create.test.ts` (manual create → `received` + `trip.create` audit, `import_batch_id` null; manual create with an existing external id → update/no-op, never a duplicate) — depends on T055

**Checkpoint**: The manual exception path reuses the same domain + match semantics.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [X] T057 [P] Add seed `packages/db/seed/import-sample.ts` (a labeled **scaffolding** default template + status-mapping rows + a fuzzy-tolerance documented default; sample CSV/XLSX fixtures) and a `db:seed:import` script in `packages/db/package.json` (quickstart.md; Constitution II — reasons/tolerance are documented defaults, not final)
- [X] T058 [P] Infra: add the `worker` service to `infra/.../docker-compose.yml` (runs `pnpm --filter @brazil-tms/workers start`) and raise the Caddy request-body limit for `POST /api/imports` (App Router has no per-route body-size knob — R4)
- [X] T059 Run quickstart.md validation end-to-end (US1–US6 walkthrough) and confirm Success Criteria SC-001…SC-010, including a **SC-004 timing check** (a 1,000-row fixture is parsed → validated → ready-to-confirm within 5 minutes; if it is not asserted in CI, record the measured time in the PR notes)
- [X] T060 Quality gate: `pnpm lint` · `pnpm typecheck` · `pnpm build` · `pnpm test` (with `DATABASE_URL`) · `pnpm exec vitest run --project workers` · feature e2e `trip-import.spec.ts`. Run e2e against a **production build** (`next start` + `PLAYWRIGHT_BASE_URL`, `--workers=1`), not `next dev`; the pre-existing 001/002 admin-UI e2e failures are environment-only (MEMORY: reset with `db:seed:e2e`)
- [X] T061 [P] Update PR notes/migration docs per the DELIVERY-WORKFLOW PR template (5 new tables + 3 enums + the `trips.import_batch_id` FK; new env `IMPORT_BUCKET` + a private Storage bucket; **new worker service** added to docker-compose; Caddy upload limit; the R2 trip-write promotion into `@brazil-tms/db`; reuse of `import_trips` — no new key; flag the **four business-blocked inputs**); open the PR against **`dev`**

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)** → no deps.
- **Foundational (P2)** → after Setup; **blocks all stories**. DB chain: enums (T004) → schema files (T005‖T006‖T007‖T008‖T009, respecting T006⇐T004, T007⇐T004/T006) → index (T010) → generate (T011) → **hand FK (T012)** → migrate (T013). The **R2 promotion** (T014→T015→T016) runs alongside the DB chain (different files), but T016 needs T013 (migrated DB) to run the verification. The shared block (T017→T018; T019⇐T017/T018; T020‖T021) and Storage/worker (T022‖; T023⇐T013/T003; T024‖) run alongside.
- **US1 (P3)** → after Foundational. **MVP** — builds the full pipeline + config + UI.
- **US2 (P4)** → after US1 (extends validate/confirm + the error-report job + UI).
- **US3 (P5)** → after US1 (extends detect-duplicates + confirm).
- **US4 (P6)** → after US1 (extends validate + adds the alias resolve surface).
- **US5 (P7)** → after US1 (`listBatches` exists in T028; adds the list endpoint + history UI).
- **US6 (P8)** → after Foundational + US1's core match (T032) + the promoted `createTrip` (T014).
- **Polish (P9)** → after all desired stories.

### Within each story

Config/service (uses the engine + promoted domain) → worker job(s) → BFF route(s) → UI → Vitest/e2e. Vitest accompanies
the implementation it covers (constitution quality gate). The import pipeline is built once in **US1**; US2–US6 each
extend or verify one facet of it (honest layering — like 003's verification phases).

### Parallel opportunities

- Setup: T002 ‖ T003 (after T001).
- Foundational: schema files T005‖T006‖T007‖T008‖T009 (after T004); T014 (promotion) ‖ the DB chain; T017→T018 then T019, with T020‖T021 ‖ the engine; T022‖T024 ‖ T023.
- US1: T025‖T026‖T027 (config) ‖ T035 (rows); the pipeline T030→T031→T032→T033 is sequential (chained jobs); tests T037‖T038 then T039, T040 after the routes/UI.
- Cross-story: US2, US3, US4 each extend US1's pipeline in **different files** (generate-error-report vs detect-duplicates vs validate/aliases) and can largely proceed in parallel once US1's jobs exist.

---

## Parallel Example: Foundational

```bash
# After T004 (enums), the five schema files:
Task: "T005 import-templates.ts" ; Task: "T006 import-batches.ts" ; Task: "T007 import-rows.ts" ; Task: "T008 status-mappings.ts" ; Task: "T009 location-aliases.ts"
# alongside the DB chain: the R2 promotion + the shared/engine block:
Task: "T014 promote trip-write path into @brazil-tms/db" ; Task: "T017 import/engine.ts" ; Task: "T020 audit actions" ; Task: "T021 import_trips invariants test" ; Task: "T022 supabase/storage.ts"
# then T010 index → T011 generate → T012 hand FK → T013 migrate ; T023 worker bootstrap after T013
```

## Parallel Example: User Story 1

```bash
# Config (different files):
Task: "T025 import-templates-service.ts" ; Task: "T026 import-templates routes" ; Task: "T027 status-mappings service+route" ; Task: "T035 import-rows-service + rows route"
# the chained pipeline is sequential: T030 parse → T031 validate → T032 detect-duplicates → T033 confirm
```

---

## Implementation Strategy

### MVP first (User Story 1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational (CRITICAL — migrates the 5 tables + FK, promotes the trip-write path, ships
   the engine + worker) → 3. Phase 3 US1 (upload → map → validate → match → confirm → Received trips + batch).
4. **STOP & VALIDATE**: configure a template, upload a clean fixture, confirm, see Received trips linked to the batch,
   re-confirm with 0 duplicates. Demo.

### Incremental delivery

Foundational → **US1** (MVP: import new trips) → **US2** (validation/errors) → **US3** (duplicates/update/no-op) →
**US4** (unknown-location mapping) → **US5** (batch history) → **US6** (manual create) → Polish. Each story is an
independently testable increment over the US1 pipeline.

### Parallel team strategy

After US1's pipeline exists: Dev A → US2 (error report), Dev B → US3 (duplicate semantics), Dev C → US4 (location
aliases) — they touch different worker jobs/services. US5/US6 follow.

---

## Notes

- **[P]** = different files, no incomplete dependency. Same-file edits (`enums.ts`, `schema/index.ts`,
  `shared/src/index.ts`, `audit/actions.ts`, the shared `imports/page.tsx`) are intentionally **not** marked [P] across
  tasks — they serialize.
- **Reuse, do not redefine** (FR-027/FR-028): the confirm job **calls** promoted `createTrip`/`updateTripPlan` from
  `@brazil-tms/db`; import never declares a parallel status set, transition table, or trip-write logic, and **never
  transitions status from the file** (trips land in `received`; Status Mapping is record/validate only — R10).
- **Heavy work in the worker** (STACK §2/§6.3): parse/validate/detect-duplicates/generate-error-report/confirm run as
  pg-boss jobs; the BFF only uploads + enqueues. Freshness is **TanStack Query polling** — **no Realtime**.
- **One engine, config-driven** (Constitution V): templates/status-mappings/location-aliases are Zod-validated DB config;
  no per-customer code.
- **Storage**: original file + error report live in the private `imports` bucket; only keys/metadata in Postgres;
  downloads via server-issued signed URLs (service-role server/worker-only).
- **Idempotency**: confirm is per-row best-effort keyed on `(import_batch_id, row_number)` + `applied_at`; the trips
  partial unique index `(customer_id, external_trip_id)` is the race backstop.
- **Append-only / immutable**: `import_rows.raw` is write-once; `audit_logs`/`trip_events` stay append-only (003);
  templates/aliases archive via `archived_at` (no hard delete).
- Commit after each task or logical group; open the PR against **`dev`** (never `main`); AI must not merge to `main`.
- **Out of scope** (do NOT build — research R14 / spec Out of Scope): API + email ingestion (`INT-008/009`); trip
  list/detail/board/dashboard (005); dispatch (006); SLA/events/exceptions (007); documents/billing/export (008);
  reports (009); **inline master-data location creation** (002); **status transitions driven from the file** (006/007).
- **Business-blocked (Constitution II — labeled scaffolding)**: real Shopee/DHL/ML files, per-customer **status
  vocabularies**, the **fuzzy-duplicate tolerance** values, and **required-field overrides** are documented-default
  scaffolding — customer-template sign-off is **NOT** final.
