# Slice 015 — Self-test guide (Collapse Validation Statuses into "Recebida")

How to stand up the local stack and verify the **validation-status collapse**: imported trips now land
as **"Recebida"** (the first *dispatchable* status), assign directly **"Recebida" → "Atribuída"** with no
validate hop, the **"Confirmar atribuição"** step still works, **unassign returns to "Recebida"**, legacy
`validated`/`validation_error` trips were backfilled to "Recebida", and a new guard stops the generic
status route from minting assignment-phase states. Host: Windows + PowerShell. Prereqs: Docker Desktop
running, Node 22 / pnpm, `pnpm install` done. This slice is a **corrective, cross-cutting** change that
references shipped slices 003 (status machine), 004 (import), 006 (dispatch), 013 (predefined template),
014 (auto-validate) and **supersedes 014's born-`validated`** decision.

**What changed (one screen of context):**

- The trip status machine dropped **two** states — `validation_error` ("Erro de validação") and
  `validated` ("Validada"). The active machine is **16** values (was 18); `received` is now the first
  **dispatchable** status. Transitions: `received → assigned` (assign), `assigned → received` (unassign),
  `assigned → confirmed` (confirm). **`confirmed` and everything after are UNCHANGED.**
- Imports are **born `received`** (was `validated`). The `/dispatch` queue filters `status=received`.
- **TRAP — `import_batch_status` is a SEPARATE enum and is untouched.** The `/imports` screen still shows
  the import **batch** as **"Validado"** (`Imports.status.validated`) as it moves
  `Recebido → Lendo arquivo → Validando → Validado → Confirmando → Concluído`. That is **expected**, not a
  regression — it's the file/batch lifecycle, a different namespace from the trip status badge.
- **DB enum keeps all 18 physical members** (Postgres has no `DROP VALUE`); the two removed values are
  *dormant* (retained only for immutable `trip_events` history). A one-time **data migration 0008**
  backfills any live trip off them.
- **New security guard** (review follow-up): `POST /api/trips/:id/status` rejects an assignment-phase
  `toStatus` (`received`/`assigned`/`confirmed`) with **409 `USE_ASSIGNMENT_ENDPOINT`** — those must go
  through the dedicated `/assignment` endpoints.
- Freshness is **polling** (TanStack Query) — no Realtime (board/detail ~30 s, dashboard ~60 s).

> Your local `.env` files already exist (gitignored): `infra/supabase/.env`, `apps/web/.env.local`,
> `packages/db/.env`, `workers/.env`. Slice 015 adds **no** env var.

## 1. Bring it up

```powershell
docker compose -f infra/supabase/docker-compose.yml up -d   # Postgres + GoTrue + Storage + gateway + Mailpit
# Wait until GoTrue is healthy (gateway proxies /auth/v1):
curl http://localhost:8000/auth/v1/health                   # -> HTTP 200 {"name":"GoTrue",...}

pnpm --filter @brazil-tms/db db:migrate            # applies 0000 -> 0008 (0008 = the data-only backfill)
pnpm --filter @brazil-tms/db db:seed               # bootstrap Admin (first user)
pnpm --filter @brazil-tms/db db:seed:e2e           # role accounts (table in §2)
pnpm --filter @brazil-tms/db db:seed:master-data   # customer "Shopee (Demo)" (DEMO-SHOPEE) + CD-SP/CD-RJ + a carrier + 2 vehicles
pnpm --filter @brazil-tms/db db:seed:resources     # drivers + vehicles + trailers  (REQUIRED to assign)
pnpm --filter @brazil-tms/db db:seed:locations     # 12 CD codes under DEMO-SHOPEE   (more import lanes; optional)
```

> **Migration 0008** is a data-only `--custom` migration (no schema diff). It runs three idempotent
> `UPDATE`s — `trips.current_status`, `trips.disputed_from_status`, and `status_mappings.internal_status`
> in `{validated, validation_error}` → `received`. `trip_events` history is left intact. Re-running it
> matches nothing.
>
> **Heads-up on seeds:** `db:seed:resources` and `db:seed:locations` (and `db:reset:trips`) are **local
> dev seeds** (working-tree only, not committed). You need `resources` for drivers+vehicles (assign fails
> without them) and a customer + location codes (`master-data` and/or `locations`) so import rows resolve
> origem/destino — an unknown code errors `UNKNOWN_LOCATION`. `db:reset:trips` wipes all trips (keeping
> master data + import batches) if you want to re-run an import cycle clean.

**Run the app and the worker.** The **worker is REQUIRED** for the import→confirm path (it parses,
validates, and *creates the trips born `received`*); everything else (assign/unassign/confirm/milestones/
backfill/guard) works with the **app alone**.

```powershell
# Terminal A — app (BFF + all screens) on http://localhost:3000
pnpm --filter @brazil-tms/web dev
# Terminal B — the single pg-boss worker (parse / validate / detect-duplicates / confirm-import)
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
pnpm --filter @brazil-tms/workers start          # logs "[worker] import worker started; queues ready."
```

> The app DB host port is **5433** (`infra/supabase/.env` sets `SUPABASE_DB_PORT=5433`; every
> `DATABASE_URL` in the repo uses it). The worker also needs `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
> (+ optional `IMPORT_BUCKET`, default `imports`) to download the uploaded file — already in `workers/.env`.
>
> **Worker-restart trap (slice-015 specific):** if you edited `confirm-import`, **restart the worker** —
> a stale/duplicate pg-boss worker keeps birthing trips at the old status and masks the fix. The tell that
> the *running* worker is correct: the `trip.create` audit `newValue.currentStatus` reads **`received`**.

- Mailpit (part of the stack, unrelated): http://localhost:8025

## 2. Test accounts (from `db:seed:e2e`)

`packages/db/seed/e2e-accounts.ts`. The keys that matter for slice 015: `import_trips` (upload/confirm),
`assign_resources` (the dedicated assign/unassign/confirm-assignment routes), `update_trip_status`
(execution milestones via `/status`), `view_all_trips` (reads).

| Email | Password | Role | Import | Assign / Unassign / Confirm-assign | Milestones | Read |
|---|---|---|:--:|:--:|:--:|:--:|
| admin@braziltransports.com.br | `ChangeMe!Admin123` | Admin | ✅ | ✅ | ✅ | ✅ |
| opsmanager@braziltransports.com.br | `ChangeMe!Ops123` | Operations Manager | ✅ | ✅ | ✅ | ✅ |
| dispatcher@braziltransports.com.br | `ChangeMe!Dispatcher123` | Dispatcher | ❌ | ✅ | ✅ | ✅ |
| fleetcoord@braziltransports.com.br | `ChangeMe!Fleet123` | Fleet Coordinator | ❌ | ✅ | ❌ | ✅ |
| finance@braziltransports.com.br | `ChangeMe!Finance123` | Finance | ❌ | ❌ | ❌ | ✅ |

> **Use `opsmanager@` (or `admin@`) for the full walkthrough** — both hold all four keys and can drive
> import → assign → confirm → milestones single-handedly. A plain **dispatcher** can do everything *except*
> the import step. **Finance** is read-only here. Login page is `/login`; fields **"E-mail"** / **"Senha"**;
> button **"Entrar"**.
>
> Also seeded but skip them: `temppw@` (forces a password change) and `disabled@` (cannot sign in). There
> is **no seeded `control_tower` account** — that's the role that has `update_trip_status` but *not*
> `assign_resources` (the canonical bypass actor for §5.6). The 409 guard returns the same regardless of
> caller, so any `update_trip_status` holder (e.g. dispatcher) demonstrates it.

## 3. What slice 015 changed (so you know what "correct" looks like)

**The 16 active statuses + their pt-BR badge labels** (`Trips.status`). A trip badge may only ever show
one of these — **"Validada" and "Erro de validação" must appear nowhere**:

| received | assigned | confirmed | at_origin | loading | loaded | in_transit | at_destination |
|---|---|---|---|---|---|---|---|
| **Recebida** | **Atribuída** | **Confirmada** | Na origem | Carregando | Carregada | Em trânsito | No destino |

| unloading | unloaded | completed | billing_pending | billing_ready | billed | cancelled | disputed |
|---|---|---|---|---|---|---|---|
| Descarregando | Descarregada | Concluída | Faturamento pendente | Pronta p/ faturar | Faturada | Cancelada | Em disputa |

Transitions you'll exercise: `received → assigned` (assign), `assigned → confirmed` (confirm),
`assigned → received` (unassign). Partition: 10 active + 6 closed = 16.

## 4. Automated tests (slice-015 relevant)

```powershell
pnpm -w lint ; pnpm -w typecheck ; pnpm -w build     # static gate. typecheck is the net: any leftover
                                                     # 'validated'/'validation_error' TS literal fails here.
```

> A pre-existing typecheck error in `packages/db/seed/resources-sample.ts` (`.rowCount`) is an **untracked
> dev seed**, not part of slice 015 — it predates this work and is not in the PR.

```powershell
# Pure unit (no DB): the 16-value machine + the assignment schema.
pnpm --filter @brazil-tms/shared exec vitest run src/domain/trip-status.test.ts   # 16 statuses, 10 active, 6 closed; received->assigned, assigned->received legal
pnpm --filter @brazil-tms/shared exec vitest run src/schemas/trip-assignment.test.ts

# DB-backed: run from REPO ROOT with --project web + DATABASE_URL set (the --filter exec form breaks the @/ alias).
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
pnpm exec vitest run --project web --no-file-parallelism `
  apps/web/lib/trips/trip-assignments.test.ts `   # assign from received
  apps/web/lib/trips/trip-unassign.test.ts `      # unassign assigned -> received
  apps/web/lib/trips/trip-transitions.test.ts `   # full lifecycle drops the validated leg
  apps/web/lib/trips/trips-service.test.ts `      # born received; the born-validated test was DELETED
  apps/web/lib/trips/trip-reassign.test.ts        # keeps reassign-from-confirmed

# Worker (load workers/.env first for the Storage env, then):
pnpm --filter @brazil-tms/workers exec vitest run jobs/confirm-import/confirm.test.ts   # born received; assigns immediately; KEEPS batch.status "validated"
pnpm --filter @brazil-tms/workers exec vitest run jobs/detect-duplicates/duplicates.test.ts
```

E2E (Playwright) — run against a **prod build**, `--workers=1`, reset accounts first:

```powershell
pnpm --filter @brazil-tms/db db:seed:e2e
$env:PLAYWRIGHT_BASE_URL='http://localhost:3000'
pnpm --filter @brazil-tms/web exec playwright test `
  e2e/dispatch-board.spec.ts `        # INVERTED: a received trip is now INCLUDED in the queue
  e2e/dispatch-assignment.spec.ts `   # assign from received; the confirm test still passes
  e2e/trip-import.spec.ts `           # INVERTED: post-confirm badge reads "Recebida" (not "Validada")
  e2e/trip-lifecycle.spec.ts `        # born Recebida -> assign -> CONFIRM step -> execution -> billing-ready
  e2e/trips-control-tower.spec.ts `   # status=received board filter
  e2e/execution-authz.spec.ts `       # the 409 USE_ASSIGNMENT_ENDPOINT guard
  --workers=1
```

> `pnpm test` shows DB suites "skipped" because each is `describe.skipIf(!process.env.DATABASE_URL)`.
> Running the **whole** e2e suite at once has known unrelated flakes (worker-stall under load, teardown
> FK-order, two pre-existing `execution-authz` bugs) — run the targeted specs above for clean signal, and
> restart the worker before worker-dependent specs.

## 5. Manual walkthrough

Open **http://localhost:3000**, sign in as **opsmanager@** (UI is pt-BR). §5.1–§5.4 need the **worker**
running (Terminal B) for the import; §5.5–§5.6 are app-only.

### 5.1 US1 — import → trips land as "Recebida" and are dispatchable
1. Go to **`/imports`** ("Importar Viagens"). There is **no template/"Modelo" step** (removed in slice 013);
   the amber "formato padrão provisório" banner is expected. Pick customer **"Shopee (Demo) (DEMO-SHOPEE)"**,
   choose a CSV (below), click **"Importar"**. (`POST /api/imports`, needs `import_trips`.)
   Save this as `teste-015.csv` (dates are `dd/MM/yyyy HH:mm`, America/Sao_Paulo; codes must be seeded):
   ```csv
   id_viagem,origem,destino,janela_coleta_inicio,janela_coleta_fim,janela_entrega_inicio,janela_entrega_fim,tipo_veiculo,status
   TESTE-015-001,CD-SP,CD-RJ,08/06/2026 08:00,08/06/2026 12:00,09/06/2026 08:00,09/06/2026 12:00,truck,
   ```
   *(Leave `status` blank to avoid a harmless `UNMAPPED_STATUS` warning. `id_viagem`/`origem`/`destino` are
   required; the windows/`tipo_veiculo` are optional. Use a real CSV — typed xlsx date cells don't parse.)*
2. Watch the **"Andamento"** card: the **batch** moves `Recebido → Lendo arquivo → Validando → **Validado**`.
   When it reads **"Validado"**, the **"Confirmar importação"** button enables (review the preview), click it →
   batch goes `Confirmando → Concluído` with the inline **"Importação concluída com sucesso."**
   *(Seeing "Validado"/"Validando" here is the **import batch** status — correct and unchanged. It is **not**
   a trip status.)*
3. Open **`/dispatch`** (**"Expedição"**). The new trip appears in **"Fila de atribuição"** with badge
   **"Recebida"** and an **"Atribuir"** action. ✅ *This is the headline: imported trips are dispatchable at
   "Recebida" — there is no "Validar" step.* (If it's missing, the worker didn't run/finish — check Terminal B.)
4. Click **"Atribuir"** → dialog **"Atribuir recursos"** → pick **"Motorista"** + **"Veículo"** (any active
   owned driver + a truck from `db:seed:resources`; leave Reboque/Transportadora empty) → click **"Atribuir"**.
   The dialog closes and the trip becomes **"Atribuída"** — **no `ILLEGAL_TRANSITION`**, no validate hop.

### 5.2 FR-007 — the confirm step still works (out of scope = unchanged)
1. Open the trip (`/trips/[id]`) → **"Atribuição de recursos"** panel. On the **"Atribuída"** trip the
   **"Confirmar atribuição"** button is present → click it → badge becomes **"Confirmada"**.
2. The **"Linha do tempo"** now shows **"Próximo marco: Na origem"** (and the execution milestones continue
   `Na origem → … → Concluída` exactly as before). Slice 015 did **not** touch the confirm step or anything
   after it.

### 5.3 US2 — unassigning returns a trip to "Recebida"
1. On an **"Atribuída"** trip (assign one again if you just confirmed), open the assignment panel → click
   **"Remover atribuição"**. The dialog reads **"Os recursos serão removidos e a viagem voltará para
   Recebida. O histórico é mantido."** → click **"Remover"**.
2. The trip returns to **"Recebida"** and **reappears in the `/dispatch` queue**. The prior assignment is
   retained in **"Histórico de atribuições"** (superseded, not deleted).

### 5.4 FR-009 — "Validada" / "Erro de validação" appear nowhere
Spot-check the operator surfaces — none should show either label:
- Trip **badges** on `/dispatch` and `/trips` (Torre de Controle).
- The **`/trips` status filter chips** ("Status" section): the selectable chips are exactly the 16 from §3 —
  **no "Validada", no "Erro de validação"**.
- The dispatch queue, the assign/unassign dialogs, and the trip inspector.

*(Reminder: the **`/imports`** screen showing the **batch** "Validado" is a different concept and is correct.)*

### 5.5 US3 — legacy trips were resolved by migration 0008 (app-only)
Any trip that existed in `validated`/`validation_error` before the collapse now reads **"Recebida"**, renders
with a badge, and is dispatchable. Verify at the DB (port 5433):

```sql
-- expect 0 rows (no live trip stranded in a dormant status):
SELECT current_status, count(*) FROM trips
 WHERE current_status IN ('validated','validation_error') GROUP BY 1;
SELECT count(*) FROM trips WHERE disputed_from_status IN ('validated','validation_error');   -- expect 0
-- history is INTENTIONALLY preserved (may be > 0):
SELECT count(*) FROM trip_events WHERE status_after IN ('validated','validation_error');
```

```powershell
docker compose -f infra/supabase/docker-compose.yml exec db psql -U postgres -d postgres
```

> Expected: the first two return **0**; the third may be **> 0** (immutable history). If you open a *legacy*
> trip whose history has a `validated`/`validation_error` event, the **timeline** renders that historical row
> as the **raw string** (e.g. `validated → received`) instead of a localized label — this is **by design**
> (the inspector falls back to the raw string for any non-active status; the trip's *current* badge correctly
> reads "Recebida"). Fresh DBs created after 0008 will have **zero** such rows.

### 5.6 The security guard — `USE_ASSIGNMENT_ENDPOINT` (app-only)
Assignment-phase states must go through the dedicated `/assignment` endpoints; the generic status route
refuses them, so an `update_trip_status` holder can't mint an "assigned" trip with no assignment row.

```powershell
# 1. sign in (any update_trip_status holder; dispatcher works), capture cookies.
#    (PowerShell: single-quoted JSON is passed to curl.exe verbatim — do NOT backslash-escape the quotes.)
curl.exe -i -c cookies.txt -X POST http://localhost:3000/api/auth/sign-in `
  -H "Content-Type: application/json" `
  -d '{"email":"dispatcher@braziltransports.com.br","password":"ChangeMe!Dispatcher123"}'

# 2. THE GUARD — try to assign via the generic status route → expect 409 USE_ASSIGNMENT_ENDPOINT
curl.exe -i -b cookies.txt -X POST http://localhost:3000/api/trips/<TRIP_ID>/status `
  -H "Content-Type: application/json" `
  -d '{"toStatus":"assigned","expectedFromStatus":"received"}'
#  -> HTTP 409  {"error":{"code":"USE_ASSIGNMENT_ENDPOINT","message":"Transição de atribuição não permitida por esta rota; use os endpoints de atribuição/confirmação."}}
#  Same 409 for toStatus=confirmed and toStatus=received. The trip's status is UNCHANGED, no assignment row.
```

- A **legal milestone** through the same route is still accepted — e.g. on a `confirmed` trip
  `{"toStatus":"at_origin","expectedFromStatus":"confirmed"}` → **200**.
- The **correct** way to assign is `POST /api/trips/:id/assignment` (needs `assign_resources`) — which is
  exactly what the `/dispatch` "Atribuir" button calls.

## 6. Tear down

```powershell
docker compose -f infra/supabase/docker-compose.yml down -v   # stop + wipe DB + Storage volumes
# Ctrl+C the app (Terminal A) and the worker (Terminal B)
```

> `down -v` wipes the database; re-run the §1 migrate + seeds after a fresh bring-up. Out of scope for this
> slice (and unchanged): the confirm-step removal, the confirmation-cutoff SLA, the `import_batch_status`
> enum, and any manual "Validar" UI.
