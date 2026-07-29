# Feature 004 — Self-test guide (Trip Import, Templates, Validation & Duplicate Handling)

How to stand up the local stack and test the import pipeline. Host: Windows + PowerShell.
Prereqs: Docker Desktop running, Node 20+/pnpm, `pnpm install` already done.

This is the first slice that **activates the worker** (pg-boss) and **Supabase Storage**, so two
things differ from 001/002/003: the compose now includes a **Storage** service (you create one
private bucket once), and you must run **two processes** — the app *and* the worker. Heavy
parse/validate/dedup/confirm runs in the worker; the screen never blocks (progress is polled).

> Your local `.env` files already exist (gitignored): `infra/supabase/.env`, `apps/web/.env.local`,
> `packages/db/.env`, `workers/.env`. Each already has `IMPORT_BUCKET=imports` +
> `SUPABASE_SERVICE_ROLE_KEY` / `*_SUPABASE_URL` / `DATABASE_URL`. On a fresh machine, copy each
> `.env.example` and fill in (demo JWT keys are fine for local).

## 1. Bring it up

```powershell
docker compose -f infra/supabase/docker-compose.yml up -d   # Postgres + GoTrue + gateway + Storage + Mailpit
# Wait until GoTrue + Storage are healthy:
curl http://localhost:8000/auth/v1/health                   # -> HTTP 200 {"name":"GoTrue",...}

pnpm --filter @brazil-tms/db db:migrate                     # 001+002+003 + 004 (5 tables, 3 enums, trips FK)
pnpm --filter @brazil-tms/db db:seed:e2e                    # role accounts (table in §2)
pnpm --filter @brazil-tms/db db:seed:master-data            # customer "Shopee (Demo)" + locations CD-SP/CD-RJ
pnpm --filter @brazil-tms/db db:seed:import                 # default template + status mappings (scaffolding)
```

**Create the private `imports` bucket — once per fresh DB volume** (Storage doesn't auto-create it):

```powershell
$srk = ((Select-String -Path infra/supabase/.env -Pattern '^SERVICE_ROLE_KEY=').Line -split '=',2)[1]
# create (idempotent enough — re-running just returns "already exists"):
Invoke-RestMethod -Method Post -Uri http://localhost:8000/storage/v1/bucket `
  -Headers @{ Authorization = "Bearer $srk"; apikey = $srk } -ContentType 'application/json' `
  -Body (@{ id='imports'; name='imports'; public=$false } | ConvertTo-Json)
# verify it exists:
Invoke-RestMethod -Uri http://localhost:8000/storage/v1/bucket -Headers @{ Authorization="Bearer $srk"; apikey=$srk }
```

**Run two processes** (separate terminals):

```powershell
# Terminal A — app (BFF + Trip Import screen) on http://localhost:3000
pnpm --filter @brazil-tms/web dev
# Terminal B — the import worker (pg-boss; parse → validate → detect-duplicates → confirm)
pnpm --filter @brazil-tms/workers start         # logs "[worker] import worker started; queues ready."
```

> ⚠️ If the worker is **not** running, an uploaded batch is created but stays at `received` forever
> (nothing drains the queue). Start Terminal B before confirming an upload.

- Mailpit (unrelated to import, but part of the stack): **http://localhost:8025**
- Host port 5432 taken? `SUPABASE_DB_PORT=5433` is already set in `infra/supabase/.env`.

## 2. Test accounts (from `db:seed:e2e`)

Import is restricted to **`import_trips`** (Admin + Operations Manager only — PRD §18).

| Email | Password | Role | Can import? |
|---|---|---|---|
| admin@braziltransports.com.br | `ChangeMe!Admin123` | Admin | ✅ |
| opsmanager@braziltransports.com.br | `ChangeMe!Ops123` | Operations Manager | ✅ |
| dispatcher@braziltransports.com.br | `ChangeMe!Dispatcher123` | Dispatcher | ❌ (403 / no nav) |
| finance@braziltransports.com.br | `ChangeMe!Finance123` | Finance | ❌ (403 / no nav) |
| fleetcoord@braziltransports.com.br | `ChangeMe!Fleet123` | Fleet Coordinator | ❌ (403 / no nav) |

## 3. Sample fixtures (committed)

`db:seed:import` provisions, for the **Shopee (Demo)** customer, a template **“Padrão Shopee
(scaffolding)”** (CSV columns `id_viagem, origem, destino, janela_coleta_inicio, janela_coleta_fim,
tipo_veiculo, status`; dates `dd/MM/yyyy HH:mm`, zone `America/Sao_Paulo`) and status mappings
(`Novo/Criada/Planejada/Pendente → received`). Two ready-to-upload files:

- `packages/db/seed/fixtures/import-clean.csv` — 3 valid rows (CD-SP → CD-RJ).
- `packages/db/seed/fixtures/import-errors.csv` — one of each problem: missing id, unknown location
  (`CD-XX`), bad date, and the same external id twice (in-file collision).

> These are **documented-default scaffolding** (Constitution II) — not real customer files. The
> per-customer status vocabulary, fuzzy-duplicate tolerance, and required-field overrides remain
> BLOCKED on real Shopee/DHL/ML files (PRD §29).

## 4. Automated tests

```powershell
pnpm lint ; pnpm typecheck ; pnpm build           # static gate (route exports, types, build)

# Unit only (no DB needed — engine, Zod config, permissions): the integration suites SKIP here.
pnpm test

# Integration: the DB/Storage-backed suites un-skip ONLY when DATABASE_URL is set. Set the env first:
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
$env:NEXT_PUBLIC_SUPABASE_URL='http://localhost:8000' ; $env:SUPABASE_URL='http://localhost:8000'
$env:SUPABASE_SERVICE_ROLE_KEY=((Select-String -Path infra/supabase/.env -Pattern '^SERVICE_ROLE_KEY=').Line -split '=',2)[1]
$env:IMPORT_BUCKET='imports'
pnpm exec vitest run --project workers             # parse / validate / detect-duplicates / confirm (incl. retry + idempotency)
pnpm exec vitest run --project web lib/imports     # upload/enqueue, location aliases, manual create

# End-to-end (app running; needs the e2e accounts). Against the dev server:
$env:PLAYWRIGHT_BASE_URL='http://localhost:3000'
pnpm --filter @brazil-tms/web exec playwright test e2e/trip-import.spec.ts e2e/import-history.spec.ts --workers=1
```

> Why `pnpm test` shows tests "skipped": every DB-backed suite is guarded by
> `describe.skipIf(!process.env.DATABASE_URL)` so the default run stays green without a database.
> They only execute when `DATABASE_URL` (and, for the Storage-touching ones, the `SUPABASE_*` +
> `IMPORT_BUCKET` vars) are set, as above.

## 5. Manual walkthrough (maps to the spec's Success Criteria)

Open **http://localhost:3000**, sign in as **opsmanager@** (or admin@). UI is **pt-BR**. Open
**Importações** in the sidebar (`/imports`). Make sure the **worker (Terminal B) is running**.

1. **Authz (SC — `import_trips` only).** Sign in as **dispatcher@** → no "Importações" in the nav;
   visiting `/imports` bounces home. (API: `GET /api/imports` without the key → **403**; logged out →
   **401**.)
2. **US1 — import new trips (SC-002, SC-008).** As **opsmanager@**: pick customer **Shopee (Demo)** →
   template **Padrão Shopee (scaffolding)** → upload `import-clean.csv` → you get an immediate **202**
   and the batch appears, polling `received → parsing → validating → validated` (the screen never
   blocks). The preview shows **3 rows = Válido / new**. Click **Confirmar importação** → batch →
   `completed`, **3 trips created in “Recebido” (received)**, each linked to the batch. **Re-upload the
   same file and confirm again → 0 new trips** (all `no_op` — idempotent, SC-002).
3. **US2 — validation & error export (SC-003).** Upload `import-errors.csv` → preview shows each bad
   row with a localized reason (missing id, unknown location, bad date, in-file collision). Click
   **Exportar erros** → an XLSX (signed URL) downloads listing the failed rows + reasons + original
   row numbers. **Confirmar** applies only valid/warning rows; error rows are excluded. Fix a row and
   re-import → it now passes.
4. **US3 — duplicate semantics (SC-002, SC-006).**
   - Re-upload `import-clean.csv` unchanged → all **`no_op`**, 0 new.
   - Edit one row's `tipo_veiculo` (keep the same `id_viagem`) and re-import → that row is **`update`**
     (the trip's original plan is preserved + audited; live plan updated).
   - The two `TRIP-2003` rows in `import-errors.csv` → both **error / in-file collision**, none created.
5. **US4 — unknown location (SC-005).** In the `import-errors.csv` preview, the `CD-XX` row is flagged
   **`unknown_location`** (never auto-created). Use **Mapear local** on that row → choose an existing
   location (e.g. **CD-RJ**) → the alias is saved and the rows re-validate; the next import of `CD-XX`
   auto-resolves. (Mapping to an archived/other-customer location → `INVALID_LOCATION_REFERENCE`.)
6. **US5 — batch history (SC-001, SC-007).** Open **Histórico** (`/imports/history`): every batch
   appears with file, time, customer, the four counts (new/updated/duplicate/error) and status, plus
   the error-report download. The original file + per-row `raw` are retained (traceability).
7. **US6 — manual create.** On the import screen, expand **Criar viagem manualmente** → fill customer,
   origin, destination (+ optional external id) → creates a single trip in **received**, audited,
   **`import_batch_id` null**. If you reuse an existing `(customer, external id)`, the same
   update/no-op match applies (never a duplicate).
8. **Status mapping (R10).** Add a row to `import-clean.csv` with a `status` not in the seeded set
   (e.g. `status = Desconhecido`) and re-import → that row gets a **warning `UNMAPPED_STATUS`** (recorded,
   never blocks; import always lands trips in `received` — it never transitions status from the file).
9. **Confirm retry (review gate).** If an `update` targets a trip already moved **past `confirmed`**,
   confirm reports it as **needs-review** (`REVIEW_REQUIRED`, counted as error, not applied) rather than
   silently changing it. A transient apply failure instead keeps the row retryable and holds the batch
   at `validated` so you can **Confirmar** again.

### Performance (SC-004)
A 1,000-row file is parsed → validated → ready-to-confirm well within the 5-minute target (measured
~11s locally via the worker pipeline). To see it, generate a 1,000-row CSV with the template's columns
and upload it; the batch reaches `validated` in seconds.

## 6. Tear down

```powershell
docker compose -f infra/supabase/docker-compose.yml down -v   # stop + wipe the DB AND the Storage volume
# stop the app (Ctrl+C in Terminal A) and the worker (Ctrl+C in Terminal B)
```

> `down -v` also wipes the `imports` bucket (Storage volume), so re-create it (§1) after a fresh
> bring-up. Customer-template sign-off remains **BLOCKED** on real files — this guide exercises the
> engine with documented-default scaffolding, not final customer configs.
