# Slice 013 — Self-test guide (Predefined Import Template)

How to stand up the local stack and verify the **corrective simplification of trip import**: the operator
now imports by choosing only **Cliente + Arquivo** — there is **no "Modelo" (template) step**. Every upload
is mapped against one built-in **standard format** (`STANDARD_IMPORT_TEMPLATE`), CSV-vs-XLSX is chosen from
the file extension, an always-visible **provisional banner** flags the format as a documented default, and a
non-matching file surfaces the **existing per-row reasons** instead of a silent failure. Host: Windows +
PowerShell. Prereqs: Docker Desktop running, Node 20+/pnpm, `pnpm install` already done.

This slice **references slice 004** (it does not edit the shipped 004 spec) and reuses its entire pipeline —
`import_batches`/`import_rows`, the `applyTemplate` engine, validation, duplicate detection, the error
report, preview, confirm, and history. It builds on the local stack from 004/008 (Postgres + GoTrue +
**Storage**). **No new table, column, migration, enum, permission, worker job, or dependency.**

What's different from the old (slice-004) flow:

- **The template select is gone.** The upload screen is **Cliente + Arquivo** only; the client never sends
  a `templateId`, so `import_batches.template_id` is always **null** on the operator path.
- **A batch with no template no longer fails.** The parse worker falls back to the in-code
  `STANDARD_IMPORT_TEMPLATE` (`@brazil-tms/shared`) when `template_id` is null. The old
  `"Nenhum modelo de importação selecionado."` failure is **eliminated** — see the **stale-worker
  gotcha** in §1, it is the #1 thing that breaks this test.
- **CSV vs XLSX is decided by the file name extension** (`inferFileType`, now shared by the BFF route and
  the worker), not a stored template attribute.
- **The worker is required for the whole walk.** Unlike some slices, the import only advances past
  `received` while the worker is running (the BFF is sender-only pg-boss). Restart it after pulling 013.
- **The `import_templates` table + `/api/import-templates` endpoints stay dormant** — retained for future
  per-customer configs, never read on the operator path.

> Your local `.env` files already exist (gitignored): `infra/supabase/.env`, `packages/db/.env`,
> `workers/.env`. Slice 013 adds **no** env var. The worker uses `DATABASE_URL`, `SUPABASE_URL`,
> `SUPABASE_SERVICE_ROLE_KEY`, and `IMPORT_BUCKET` (=`imports`) — all already in `workers/.env`.

## 1. Bring it up

```powershell
docker compose -f infra/supabase/docker-compose.yml up -d   # Postgres + GoTrue + Storage + gateway + Mailpit
# Wait until GoTrue is healthy (through the gateway):
curl http://localhost:8000/auth/v1/health                   # -> HTTP 200 {"name":"GoTrue",...}

pnpm --filter @brazil-tms/db db:migrate                     # applies through 0007 (013 adds NO migration; import tables are 0003)
pnpm --filter @brazil-tms/db db:seed                        # bootstrap the first Admin
pnpm --filter @brazil-tms/db db:seed:e2e                    # role accounts (table in §2)
pnpm --filter @brazil-tms/db db:seed:master-data            # customer "Shopee (Demo)" (DEMO-SHOPEE) + locations CD-SP, CD-RJ
pnpm --filter @brazil-tms/db db:seed:buckets                # provisions the `imports` Storage bucket (idempotent) — REQUIRED for upload
# DO NOT run db:seed:import — leaving it out keeps DEMO-SHOPEE with ZERO templates, which is the whole point:
#   prove a customer with no template can import. (See §3 for an optional status-mapping nicety.)
```

> `db:migrate` runs migrations 001→0007. The import tables (`import_templates`, `import_batches`,
> `import_rows`, `status_mappings`, `location_aliases`) come from **0003** (slice 004). Slice 013 ships
> **no** migration. `db:seed:buckets` needs the stack up + `SUPABASE_SERVICE_ROLE_KEY` (already in
> `workers`/`db` `.env`); it ensures the `imports` bucket the upload writes to.

**Run the app and the worker — both are needed for the entire manual walk.** Two terminals:

```powershell
# Terminal A — app (BFF + the /imports screens) on http://localhost:3000
pnpm --filter @brazil-tms/web dev

# Terminal B — the single worker (pg-boss). It drains parse -> validate -> detect-duplicates ->
# [generate-error-report] and, on user confirm, the confirm job. Reads workers/.env (DATABASE_URL etc.).
pnpm --filter @brazil-tms/workers dev
```

> ⚠️ **STALE-WORKER GOTCHA — read this.** The worker loads compiled code into memory at startup. A worker
> that was already running **before** you pulled slice 013 still runs the **old** parse code, which
> hard-fails every null-template batch with **`"Nenhum modelo de importação selecionado."`** (visible as a
> red **Falhou** badge and in `import_batches.error_message`). If your imports fail that way, you are
> testing stale code. **Kill Terminal B and restart `pnpm --filter @brazil-tms/workers dev`.** (`tsx watch`
> reloads on source edits, but a worker started before the checkout must be restarted once.) Quick check
> after restart: upload a no-template CSV (§5.3) → it should reach **Validado**, never **Falhou** with the
> "Nenhum modelo…" message.

- Mailpit (part of the stack, unrelated to 013): **http://localhost:8025**
- App DB: `postgres://postgres:postgres@127.0.0.1:5433/postgres` (`SUPABASE_DB_PORT=5433` in
  `infra/supabase/.env`; `DATABASE_URL` in `packages/db/.env`).

## 2. Test accounts (from `db:seed:e2e`)

Import endpoints require the **`import_trips`** permission, held by exactly **Admin** and **Operations
Manager** (verified in `packages/shared/src/auth/permissions.ts`). Sign in at **http://localhost:3000**.

| Email | Password | Role | Can import? (`import_trips`) |
|---|---|---|:--:|
| admin@braziltransports.com.br | `ChangeMe!Admin123` | Admin | ✅ |
| opsmanager@braziltransports.com.br | `ChangeMe!Ops123` | Operations Manager | ✅ |
| finance@braziltransports.com.br | `ChangeMe!Finance123` | Finance | ❌ → **403** |
| dispatcher@braziltransports.com.br | `ChangeMe!Dispatcher123` | Dispatcher | ❌ → **403** |
| fleetcoord@braziltransports.com.br | `ChangeMe!Fleet123` | Fleet Coordinator | ❌ → **403** |

- **No session → 401** on every import endpoint; an authenticated role **without** `import_trips` → **403**.
- Slice 013 introduces **no new permission** (FR-009) — the set of users who can import is unchanged.
- Role-change tests can pollute the seeded admin's role; re-run `pnpm --filter @brazil-tms/db db:seed:e2e`
  to reset accounts.

## 3. Seeded data & the standard format

**The standard format** (`STANDARD_IMPORT_TEMPLATE`, `packages/shared/src/import/standard-template.ts`) — the
slice-004 demo mapping, verbatim, as one in-code object. Source header → internal field:

| source header | internal field | required (validation) |
|---|---|---|
| `id_viagem` | externalTripId | ✅ present |
| `origem` | originCode | ✅ resolvable |
| `destino` | destinationCode | ✅ resolvable |
| `janela_coleta_inicio` / `janela_coleta_fim` | planned pickup window | — |
| `janela_entrega_inicio` / `janela_entrega_fim` | planned delivery window | — |
| `tipo_veiculo` | plannedVehicleType | — |
| `status` | statusLabel | — |

Parsing rules: date `dd/MM/yyyy HH:mm`, timezone `America/Sao_Paulo`, decimal `,`, thousand `.`.
`requiredOverrides` is `[]` — the slice adds **no** new required-column rule (R8).

**Sample fixtures** (ship in the repo — use these directly):

- **`packages/db/seed/fixtures/import-clean.csv`** — correctly formatted. Header:
  `id_viagem,origem,destino,janela_coleta_inicio,janela_coleta_fim,tipo_veiculo,status` with rows like
  `TRIP-1001,CD-SP,CD-RJ,01/06/2026 08:00,01/06/2026 12:00,truck,Planejada`. It omits the two optional
  `janela_entrega_*` columns — that maps cleanly (those fields stay null). `CD-SP`/`CD-RJ` are the locations
  `db:seed:master-data` creates for DEMO-SHOPEE, so origin/destination resolve.
- **`packages/db/seed/fixtures/import-errors.csv`** — same header, rows engineered to surface per-row
  reasons: an **empty `id_viagem`** (→ `MISSING_EXTERNAL_ID`), origin **`CD-XX`** (→ `UNKNOWN_LOCATION`), a
  bad date `99/99/9999 99:99`, and a **duplicate** `TRIP-2003` (in-file collision).

> **Expected nuance with master-data only (no `db:seed:import`):** DEMO-SHOPEE has **no `status_mappings`**,
> so the fixtures' `status=Planejada` is **unmapped** → each clean row shows as a **warning (Alerta)** with
> an `UNMAPPED_STATUS` reason. This is **non-blocking by design** (spec assumption): the rows are still
> confirmable and the trips land in `received`. "Imports successfully" means *reaches a confirmable preview*,
> not *zero warnings*.
>
> **Optional — make clean rows show as `Válida`:** also run `pnpm --filter @brazil-tms/db db:seed:import`.
> It adds the status mappings (`Novo`/`Criada`/`Planejada`/`Pendente` → `received`) **and** a per-customer
> template. The template is **harmless to this test** — the slice-013 client never sends a `templateId`, so
> the batch is still mapped by `STANDARD_IMPORT_TEMPLATE` and the table stays dormant. Only the status
> warnings disappear.

## 4. Automated tests

```powershell
# Static gate (route exports, types, build). If apps/web typecheck errors on a stale
# `.next/types` ref to a reverted admin/import-templates page, clear it: Remove-Item -Recurse -Force apps/web/.next
pnpm -r typecheck
pnpm run lint
pnpm --filter @brazil-tms/web build          # the build (not just tsc) catches route.ts export + next-intl key rules

# Unit (no DB): the standard-format constant + inferFileType. Always runnable.
pnpm exec vitest run --project shared        # incl. packages/shared/src/import/standard-template.test.ts

# Web integration (DB-backed; messages.test.ts itself is pure). Load env first:
$env:DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5433/postgres'
pnpm exec vitest run --project web           # incl. apps/web/lib/messages.test.ts (i18n delta)

# Worker integration (needs DB + Storage). Easiest: load workers/.env into the session, then:
$env:DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5433/postgres'
$env:SUPABASE_URL='http://localhost:8000'; $env:SUPABASE_SERVICE_ROLE_KEY='<from workers/.env>'; $env:IMPORT_BUCKET='imports'
pnpm exec vitest run --project workers parse # parse.test.ts: null-template CSV + XLSX-by-extension, no batch failure

# End-to-end (Playwright boots its own `pnpm dev`; it does NOT start a worker — see note). Reset accounts first:
pnpm --filter @brazil-tms/db db:seed:e2e
pnpm --filter @brazil-tms/web test:e2e -- trip-import --workers=1
```

> `pnpm exec vitest run --project workers` / `--project web` DB suites are guarded by
> `describe.skipIf(!process.env.DATABASE_URL)`, so a bare `pnpm test` stays green by skipping them. The
> **shared** unit suite and `messages.test.ts` need no DB.

| Suite | File | Asserts |
|---|---|---|
| Standard format (unit) | `packages/shared/src/import/standard-template.test.ts` | `STANDARD_IMPORT_TEMPLATE` parses against `templateConfigSchema`; `requiredOverrides` is `[]`; the 9 headers map in order; `inferFileType` returns csv/xlsx/null |
| Parse worker (integration) | `workers/jobs/parse/parse.test.ts` | null-template CSV → mapped via `STANDARD_IMPORT_TEMPLATE`, batch **not** failed; null-template **`.xlsx`** parsed via the extension-chosen reader; header-only → 0 rows; idempotent re-parse |
| i18n delta (unit) | `apps/web/lib/messages.test.ts` | `Imports.provisionalNotice` present; `template`/`selectTemplate`/`noTemplates` **gone**; `uploadSubtitle` no longer says "modelo"; no dotted keys |
| Import flow + authz (e2e) | `apps/web/e2e/trip-import.spec.ts` | no template control on `/imports`; banner visible; upload with **no** template → 202 + `templateId:null` + non-failed; wrong-columns → 202 (no header-level rejection); 401/403/200 authz matrix |

> ⚠️ The e2e webServer boots **only the Next app**, not a job worker, so the upload e2e tests assert the
> **BFF/UI surface** (auth, screen, banner, upload acceptance) — not the worker pipeline. The full
> validate→confirm path is covered by `parse.test.ts` and the manual walk below. If a **stale worker**
> (§1) is draining pg-boss in the background, the `upload … non-failed batch` e2e test can flake to
> **failed** (old code). Restart the worker, then re-run.

## 5. Manual walkthrough (maps to the spec's user stories)

Open **http://localhost:3000**, sign in as **opsmanager@** (or admin@). UI is **pt-BR**. Both terminals from
§1 must be running. Select customer **Shopee (Demo)** — the one with **no** template.

### 5.0 Authz (FR-009 — unchanged)
- Logged out → any `/api/imports*` route returns **401**.
- As **dispatcher@** or **finance@** → `/imports` nav is hidden and `POST /api/imports` (and the other
  import endpoints) return **403**. As **opsmanager@**/**admin@** → **2xx**.

### 5.1 US1 — no template step (the point of the slice)
1. Open **`/imports`**. Confirm the upload card shows **only two controls — Cliente and Arquivo**. There is
   **no "Modelo de importação" select** (it was removed). The subtitle reads *"Selecione o cliente e o
   arquivo a enviar."*
2. The submit button (**Importar**) enables once **both** a customer and a file are chosen — no template is
   ever requested.
3. **Expected-format helper** (so the operator knows the columns): below the file input there's a
   **Baixar modelo (.csv)** button — it downloads a ready-to-fill CSV with the standard headers + one
   example row — and a **Ver formato esperado** toggle that expands a list of every column (the three
   required ones tagged *obrigatório*), each with its meaning + an example, plus a note that the example
   codes are illustrative and origin/destination codes vary per customer (use the selected customer's
   registered locations). Both are generated from `STANDARD_IMPORT_TEMPLATE`, so they always match what the
   worker maps against.

### 5.2 US2 — provisional banner
- At the top of `/imports`, an always-visible amber banner reads:
  **"Formato de importação padrão provisório — modelo de exemplo pendente de confirmação do cliente; pode
  mudar."** This communicates the standard format is a documented default pending customer sign-off (PRD §29),
  not a final agreement.

### 5.3 US1 — import a CSV with no template
1. Select **Shopee (Demo)**, choose **`packages/db/seed/fixtures/import-clean.csv`**, click **Importar**
   (`POST /api/imports`, multipart `file` + `customerId` only → **202 `{ id }`**).
2. Watch the **Andamento** card poll through **Recebido → Lendo arquivo → Validando → Validado** (Terminal B
   drains parse → validate → detect-duplicates). It must **never** hit **Falhou** with "Nenhum modelo…" — if
   it does, you have a **stale worker** (§1).
3. The **Prévia e validação** table lists the mapped rows: **Linha / Resultado / Correspondência /
   Observações / Ações**. With master-data only, rows show **Alerta** (UNMAPPED_STATUS, non-blocking — see
   §3); `id_viagem`/`origem`/`destino` mapped, `CD-SP`/`CD-RJ` resolved, match decision **Nova**.
4. Click **Confirmar importação** (`POST …/confirm`). Status reaches **Concluído**; the trips are created and
   land in **`received`**. Verify on the board **`/trips`** (e.g. `TRIP-1001`, `TRIP-1002`).

### 5.4 US1 — same format, XLSX (parser chosen by extension)
1. Open `import-clean.csv` in Excel/LibreOffice, keep the headers/rows, **Save As `import-clean.xlsx`**.
2. Upload it (no template). It maps and previews **identically** — the worker chose the XLSX reader purely
   from the `.xlsx` extension via `inferFileType(fileName)` (FR-004), with no template attribute involved.

### 5.5 US3 — a non-matching file shows per-row reasons (no silent failure)
1. Upload **`packages/db/seed/fixtures/import-errors.csv`** (no template). It is **accepted** (202) and the
   batch reaches **Validado** — **not** **Falhou**, and there is **no** header-level "wrong format" message.
2. In the preview, each affected row shows its existing field-level reason in **Observações**:
   - empty `id_viagem` → *"identificador externo obrigatório"* (`MISSING_EXTERNAL_ID`)
   - `CD-XX` origin → *"local … não encontrado"* (`UNKNOWN_LOCATION`) — with an inline **Mapear** control to
     map the file value to a real location (`POST …/locations`, which re-validates)
   - the duplicate `TRIP-2003` → an in-file duplicate decision
3. When there are error rows, an **Exportar erros** button appears (once the report is generated) — a 302 to
   a signed Storage URL with the failed rows + reasons (same error report as slice 004).
4. **Wrong columns entirely:** make a CSV with unrelated headers (e.g. `coluna_a,coluna_b\nfoo,bar`). It is
   still **accepted** (202); every data row is `error` with `MISSING_EXTERNAL_ID` (the required id never
   maps) — never an unexplained batch failure.
5. **Empty / header-only file:** a file with only the header line → an **empty preview** (zero data rows),
   no per-row reasons.

### 5.6 History (unchanged; reason-visibility is a deferred follow-up)
- **`/imports/history`** lists batches newest-first: **Arquivo / Cliente / Data·Hora / Resumo (n novas · n
  atualizadas · n duplicadas · n erros) / Situação / Erros (download)**. Note it deliberately does **not**
  surface batch-*failure* reasons in this slice — that's an explicit out-of-scope follow-up.

### Acceptance map

| Check | Spec |
|---|---|
| No template control; Cliente + Arquivo only | FR-001, SC-001 |
| Standard format applied for any customer, CSV + XLSX | FR-002/003/004, SC-003 |
| No "no template selected" failure | FR-005, SC-002 |
| Wrong-format → per-row reasons, no header message, no silent fail | FR-006, SC-004 |
| Provisional banner visible | FR-007, SC-005 |
| Validate/dedup/confirm/status unchanged; trips land in `received` | FR-008, SC-006 |
| `import_trips` reused; no new permission (401/403/2xx) | FR-009 |
| Dead template control/strings pruned | FR-011, FR-012 |

## 6. Tear down

```powershell
docker compose -f infra/supabase/docker-compose.yml down -v   # stop + wipe the DB + Storage volumes
# stop the app (Ctrl+C in Terminal A) and the worker (Ctrl+C in Terminal B)
```

> `down -v` wipes the database **and** Storage; re-run the §1 migrate + seeds (including `db:seed:buckets`)
> on the next bring-up. The standard import format is a **labeled §29 provisional default** — replacing it
> with a real signed-off customer format is a single-object edit to `STANDARD_IMPORT_TEMPLATE`
> (FR-010 / SC-007), with no migration or backfill.
