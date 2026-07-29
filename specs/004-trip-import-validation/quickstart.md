# Quickstart: Trip Import, Templates, Validation, and Duplicate Handling (004)

**Feature**: 004-trip-import-validation | **Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) ·
**Data model**: [data-model.md](./data-model.md) · **Contracts**: [contracts/](./contracts/)

This slice **activates the worker**: heavy parse/validate/dedup/confirm runs as `pg-boss` jobs, not in request handlers.
Stand up the stack, install the new worker deps, migrate, run **both** the app and the worker, then exercise the import
pipeline. Customer-specific template configs use **documented-default scaffolding** — final sign-off is BLOCKED on real
files (PRD §29).

## Prerequisites (same stack as 001/002/003)

```powershell
pnpm install
docker compose -f infra/supabase/docker-compose.yml up -d   # Postgres + GoTrue + gateway + Storage + Mailpit
# Wait for GoTrue health: curl http://localhost:8000/auth/v1/health  -> 200
pnpm --filter "@brazil-tms/db" db:migrate                    # 001 + 002 + 003 migrations
pnpm --filter "@brazil-tms/db" db:seed                       # bootstrap first Admin (idempotent)
pnpm --filter "@brazil-tms/db" db:seed:master-data           # customers/locations/lanes to import against
```

Create the private Storage bucket and env (server-only):

```powershell
# Create a private bucket named 'imports' via the Supabase Storage API (service-role) or Studio.
# Env (app + worker): SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL, DATABASE_URL, IMPORT_BUCKET=imports
```

## Install worker deps + apply this feature's migration + run the worker

```powershell
# New runtime deps (worker + shared parsing); keep parsers server/worker-only
pnpm --filter "@brazil-tms/workers" add pg-boss csv-parse exceljs luxon @brazil-tms/db @brazil-tms/shared postgres
pnpm --filter "@brazil-tms/db" db:generate    # drizzle-kit generate -> new SQL in packages/db/migrations/
# IMPORTANT: hand-append the cross-feature FK (drizzle-kit won't infer 003's forward hook reliably):
#   ALTER TABLE public.trips ADD CONSTRAINT trips_import_batch_id_fk
#     FOREIGN KEY (import_batch_id) REFERENCES public.import_batches(id);
pnpm --filter "@brazil-tms/db" db:migrate     # apply import_templates/import_batches/import_rows/status_mappings/location_aliases + enums + FK
pnpm --filter "@brazil-tms/db" db:seed:import # seed default template + status-mapping scaffolding (labeled; reasons/tolerance documented defaults)

# Terminal A — app (BFF + Trip Import screen)
pnpm dev
# Terminal B — worker (pg-boss; registers parse/validate/detect-duplicates/generate-error-report/confirm-import)
pnpm --filter "@brazil-tms/workers" start
```

## Verify the pipeline (Trip Import screen + service layer)

1. **US1 — Import new trips**: open the Trip Import screen, select a customer + template, upload a clean sample CSV/XLSX
   fixture → `202`; watch the batch move `received → parsing → validating → validated` (polled). Preview shows per-row
   status + the summary (new/updated/duplicate/error). Confirm → trips created in **Received**, batch `completed`, each
   trip linked to the batch (`import_batch_id`).
2. **US2 — Validation/errors**: upload a fixture with bad rows (missing required field, inactive customer, bad date) →
   each row is `valid`/`warning`/`error` with a localized reason; export the error report (signed URL); confirm applies
   only valid+warning; fix + re-import clears the errors.
3. **US3 — Duplicates**: re-import the same file unchanged → all `no_op`, **0 new trips**; re-import with a changed plan
   field on a known external id → `update` (original plan preserved, audited); upload an id-less look-alike →
   `potential_duplicate` (warning, recorded reason on create); two rows with the same `(customer, external id)` in one
   file → both `error` (in-file collision), none created.
4. **US4 — Unknown location**: upload a row whose origin code isn't in master data → row flagged `unknown_location`;
   `POST /api/imports/{id}/locations` maps it to an existing location (alias remembered) → re-validate → row resolves.
5. **US5 — Batch history**: `GET /api/imports` lists each batch (file, user, time, customer, counts, status) with the
   error-report link; original file + per-row `raw` retrievable.
6. **US6 — Manual creation**: create a trip via the trip service (003 `createTrip`) for an exception → Received status,
   audited, `import_batch_id` null; if it carries a known external id, the same match/update/no-op semantics apply.

## Tests

```powershell
pnpm --filter "@brazil-tms/shared"  test     # engine/applyTemplate, Luxon normalize, in-file collision, config Zod
pnpm --filter "@brazil-tms/db"      test     # promoted trip-write services still green (re-export parity)
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
pnpm exec vitest run --project web           # imports services: upload/enqueue, rows, confirm idempotency, resolve-location, authz
pnpm exec vitest run --project workers       # parse/validate/detect-duplicates/confirm-import (dev DB)
pnpm --filter "@brazil-tms/web"     test:e2e # Playwright: Trip Import critical path + 401/403
```

Test focus (STACK §3.13 / constitution): **import validation**, **duplicate detection** (no-op / update / potential /
in-file collision), **confirm idempotency** (re-run → 0 duplicates), unknown-location flagging, and **permission checks**
(`import_trips` → 403 for other roles).

## Quality gate before PR (targets `dev`)

```powershell
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

PR uses the template (What/Why/How-to-test/Migration+Env notes/Risks). **Migration + Env notes**: 5 new tables + 3 enums
+ the `trips.import_batch_id` FK; new env `IMPORT_BUCKET` + a private Storage bucket; new worker process (`pnpm --filter
@brazil-tms/workers start`) added to docker-compose; Caddy upload body-size limit raised. **Blocked note**: real
Shopee/DHL/ML files, per-customer status vocabularies, fuzzy-duplicate tolerance, and required-field overrides remain
BLOCKED (PRD §29) — customer-template sign-off is **not** complete; defaults are labeled scaffolding (Constitution II).
**AI does not merge to `main`.**
