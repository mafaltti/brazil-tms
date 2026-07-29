# Feature 005 — Self-test guide (Control Tower, Trip List, Trip Detail & Daily Dashboard)

How to stand up the local stack and test the **read/operating surface** over the trip domain. Host:
Windows + PowerShell. Prereqs: Docker Desktop running, Node 20+/pnpm, `pnpm install` already done.

This slice is **read-first**, so it is simpler to run than 004:

- **No worker** and **no Supabase Storage** are used — you run **one** process (the app). Freshness is
  **polling via TanStack Query** (Control Tower 30 s, Trip Detail 30 s, Home dashboard 60 s — no Realtime).
- It adds **no table / enum / permission key / worker** — just one index (`trips_pickup_start_idx`,
  migration `0004`) and read models + screens.
- It is the **first slice to enforce `view_all_trips`**: the trip read endpoints were re-gated from
  `manage_trips` → `view_all_trips` (all 7 internal roles can now **view**); **editing** live planned
  fields still requires `manage_trips` (Admin + Operations Manager).

> Your local `.env` files already exist (gitignored): `infra/supabase/.env`, `apps/web/.env.local`,
> `packages/db/.env`. Each already has `SUPABASE_SERVICE_ROLE_KEY` / `*_SUPABASE_URL` / `DATABASE_URL`.
> On a fresh machine, copy each `.env.example` and fill in (demo JWT keys are fine for local).

## 1. Bring it up

```powershell
docker compose -f infra/supabase/docker-compose.yml up -d   # Postgres + GoTrue + gateway + Storage + Mailpit
curl http://localhost:8000/auth/v1/health                   # -> HTTP 200 {"name":"GoTrue",...}

pnpm --filter @brazil-tms/db db:migrate                     # 001..004 + 005's trips_pickup_start_idx (0004)
pnpm --filter @brazil-tms/db db:seed:e2e                    # role accounts (table in §2)
pnpm --filter @brazil-tms/db db:seed:master-data            # customer "Shopee (Demo)" + locations CD-SP/CD-RJ + a lane
pnpm --filter @brazil-tms/db db:seed:trip-domain            # 1 sample trip DEMO-TRIP-001 (status received)
```

**Run one process** (the app — no worker needed for 005):

```powershell
pnpm --filter @brazil-tms/web dev                           # http://localhost:3000
```

- Host port 5432 taken? `SUPABASE_DB_PORT=5433` is already set in `infra/supabase/.env`.
- Mailpit (part of the stack, unused here): http://localhost:8025

## 2. Test accounts (from `db:seed:e2e`)

Reads (Control Tower / Trip Detail / dashboard / export) require **`view_all_trips`** — held by **all 7
internal roles**. Editing planned fields requires **`manage_trips`** — Admin + Operations Manager only.

| Email | Password | Role | View board/detail/dashboard | Edit plan fields |
|---|---|---|:--:|:--:|
| admin@braziltransports.com.br | `ChangeMe!Admin123` | Admin | ✅ | ✅ |
| opsmanager@braziltransports.com.br | `ChangeMe!Ops123` | Operations Manager | ✅ | ✅ |
| dispatcher@braziltransports.com.br | `ChangeMe!Dispatcher123` | Dispatcher | ✅ | ❌ (403) |
| finance@braziltransports.com.br | `ChangeMe!Finance123` | Finance | ✅ | ❌ (403) |
| fleetcoord@braziltransports.com.br | `ChangeMe!Fleet123` | Fleet Coordinator | ✅ | ❌ (403) |

> The seeded **admin** has `must_change_password=true` on a first UI login (set a new password when
> prompted), so prefer **opsmanager@** for the edit walkthrough. Logged-out requests to any read
> endpoint → **401**.

## 3. Sample data (and an optional richer board)

`db:seed:trip-domain` anchors exactly **one** trip — `DEMO-TRIP-001` (status **received**, on the
**Shopee (Demo)** customer, CD-SP → CD-RJ). That is enough to exercise **Trip Detail + inline edit**
(received is active/editable), but the board / dashboard / export are more interesting with trips
across several statuses and pickup dates.

**Optional — seed a richer board** (labeled demo scaffolding, Constitution II — not real customer
data). Inserts four extra trips on the demo customer, idempotently:

```powershell
docker compose -f infra/supabase/docker-compose.yml exec -T db psql -U postgres -d postgres -c @'
INSERT INTO trips (customer_id, external_trip_id, origin_location_id, destination_location_id,
                   current_status, original_plan, planned_pickup_window_start,
                   planned_pickup_window_end, planned_vehicle_type)
SELECT c.id, v.ext, o.id, d.id, v.status::trip_status, '{}'::jsonb,
       v.pickup, v.pickup + interval '2 hours', 'truck'::vehicle_type
FROM (SELECT id FROM customers WHERE customer_code = 'DEMO-SHOPEE') c
CROSS JOIN LATERAL (SELECT id FROM locations WHERE customer_id = c.id ORDER BY code ASC  LIMIT 1) o
CROSS JOIN LATERAL (SELECT id FROM locations WHERE customer_id = c.id ORDER BY code DESC LIMIT 1) d
CROSS JOIN (VALUES
  ('DEMO-BOARD-1', 'in_transit',      now()),
  ('DEMO-BOARD-2', 'validated',       now() + interval '1 day'),
  ('DEMO-BOARD-3', 'completed',       now()),
  ('DEMO-BOARD-4', 'billing_pending', now())
) AS v(ext, status, pickup)
ON CONFLICT DO NOTHING;
'@
```

That gives you: an **active** in-transit trip with **today's** pickup, an active validated trip
tomorrow, a **completed** trip today, and a **billing_pending** trip today — enough to see the active
default, every filter, the default views, the dashboard counts, and the export. (Remove them later
with `DELETE FROM trips WHERE external_trip_id LIKE 'DEMO-BOARD-%';`.)

> You can also add more **active** (`received`) trips through the UI: on **Importações** →
> **Criar viagem manualmente** (feature 004, requires Admin/Ops). There is no UI to move a trip to a
> later status yet (transitions are owned by 006/007), so use the SQL above for non-active statuses.

## 4. Automated tests

```powershell
pnpm lint ; pnpm typecheck ; pnpm build           # static gate (route exports, types, build)

# Pure unit (no DB): shared domain/Zod/permissions + the board view presets.
pnpm exec vitest run --project shared             # ACTIVE/NON_EDITABLE status sets, billing-filter map,
                                                  # trip-board schema, dayRangeSaoPaulo, view_all_trips invariants
pnpm exec vitest run --project web apps/web/lib/trips/views.test.ts   # quick-view preset conflict-clearing

# Integration (DB-backed — 005 needs ONLY DATABASE_URL; no Storage/SUPABASE vars):
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
pnpm exec vitest run --project web apps/web/lib/trips/trips-read.test.ts apps/web/lib/trips/trip-plan.test.ts
#   trips-read: board filters / AND (status∩billing) / sort / paginate+total, detail enrichment,
#               dashboard metrics (+nulls), export cap, filter-option lookups
#   trip-plan : plan edit + the merged-window guard (INVALID_PLAN_WINDOW) + review gate

# End-to-end (app running on :3000; e2e accounts seeded). Point Playwright at the running dev server:
$env:PLAYWRIGHT_BASE_URL='http://localhost:3000'
pnpm --filter @brazil-tms/web exec playwright test `
  e2e/trips-control-tower.spec.ts e2e/trip-detail.spec.ts e2e/dashboard.spec.ts e2e/trips-inspector.spec.ts `
  --workers=1
```

> Every DB-backed suite is guarded by `describe.skipIf(!process.env.DATABASE_URL)`, so a plain
> `pnpm test` stays green without a database (and the unrelated 004 `workers` storage suites will only
> pass with the `SUPABASE_*` vars set — out of scope for 005). Run the targeted projects above to keep
> the 005 signal clean. If e2e shows stale 500s on a route after code changes, restart `next dev` (a
> long-running dev server can hold a broken HMR module for an edited route).

## 5. Manual walkthrough (maps to the spec's user stories)

Open **http://localhost:3000**, sign in. UI is **pt-BR**; timezone **America/Sao_Paulo**. The
**Torre de Controle** item in the sidebar opens the board (`/trips`); the home page (`/`) is the
**daily dashboard**.

1. **Authz — first enforcement of `view_all_trips` (re-gate).** Sign in as **dispatcher@** or
   **finance@** → you **can** open the board, a trip's detail, the dashboard, and export (read-only
   roles now see trips). You **cannot** edit: the Trip Detail "Editar plano" save returns **403**.
   Sign in as **opsmanager@** to edit. (API: logged out → **401** on any read endpoint.)
2. **US1 — Control Tower board (`/trips`).** A dense, sortable, paginated table that defaults to
   **active/open** trips (received…unloaded) — the seeded `received` trip and (if you ran the SQL) the
   in-transit/validated ones show; **completed** and **billing_pending** are hidden by the active
   default. Try:
   - **Search** by external trip id / customer / lane (e.g. `DEMO-TRIP-001`).
   - The **8 data-backed filters** (customer, status, billing status, origin, destination, lane,
     vehicle type, pickup date range) — alone and combined; they compose with **AND**.
   - **Default views**: *Hoje* / *Próximas 24h* / *Em trânsito* / *Faturamento pendente*. Clicking
     *Em trânsito* or *Faturamento pendente* swaps the status dimension cleanly (no empty board), and
     keeps any customer/date filter you set.
   - **Sort** by clicking the Customer / Status / Coleta / Atualizada headers.
   - **URL persistence**: copy the URL after filtering, open it in a new tab → the same filtered board.
   - **Polling**: leave it open ~30 s → it refreshes without a manual reload.
   - Confirm there are **no** assigned-driver/vehicle/carrier or SLA-risk controls (those are 006/007).
3. **US2 — Trip Detail (`/trips/:id`).** Click a row (e.g. `DEMO-TRIP-001`). You see the **header**
   (customer, trip id, lane, status badge, SLA risk, billing), the **customer plan** (immutable
   *original plan* beside the *live planned* fields and actual milestone timestamps), the read-only
   **timeline**, **notes**, and **audit history**, plus labelled **placeholder sections** for
   Assignment (006) / Exceptions (007) / Documents (008) / Billing detail (008). A bad id
   (`/trips/<random-uuid>`) shows a clear **not-found**.
4. **US3 — edit operational fields before completion.** As **opsmanager@**, on a **received**/active
   trip click **Editar plano**, change e.g. the vehicle type or a pickup window → **save** → it
   succeeds, shows in **audit history** (critical-field changes write a `trip.plan_update`), and the
   board reflects it within one ~30 s poll. Edge cases:
   - **Inverted window** — set the pickup **end** before the **start** (or, partially, only the end
     earlier than the existing start) → rejected with **`INVALID_PLAN_WINDOW`** (no bad data written).
   - **On a closed trip** — open the SQL-seeded **completed** trip (`DEMO-BOARD-3`): the editor is
     replaced by "não pode mais ser editada" and an API edit returns **409 `EDIT_NOT_ALLOWED`**.
   - **As dispatcher@** — the save is refused (**403**).
   - *(Past `confirmed` → `REVIEW_REQUIRED`: there's no UI to move a trip past confirmed yet; it is
     covered by the integration/e2e suites. To try it manually, `UPDATE trips SET current_status =
     'at_origin' WHERE external_trip_id = 'DEMO-BOARD-1';` then edit without ticking "Revisão
     autorizada" → **409 `REVIEW_REQUIRED`**; tick it → the edit applies.)*
5. **US4 — daily dashboard (`/`).** Eight widgets. **Trips today by status** and **Billing pending**
   show **real** numbers (with the SQL seed: today's in-transit/completed/billing-pending counts, and
   billing-pending = 1). The six later-slice widgets (at-risk / on-time % / unassigned / active
   exceptions / missing documents) show a labelled **"Disponível em uma próxima etapa."** placeholder —
   no invented numbers. Click the **billing pending** widget (or a *trips-today* status row) → the
   Control Tower opens **filtered** to those trips (the today rows carry today's date range).
6. **US5 — export the filtered list.** Filter the board, then **Exportar CSV** → a CSV downloads
   containing **exactly** the filtered rows + the board columns. It has a UTF-8 BOM and uses `;`
   delimiters, so pt-BR accents render correctly in Excel. Change the filters → the file contents
   change. The export is capped at **10,000** rows; an over-cap result returns a clear error instead of
   a truncated file (hard to hit manually — covered by the integration/e2e suites).

## 6. Tear down

```powershell
docker compose -f infra/supabase/docker-compose.yml down -v   # stop + wipe the DB volume
# stop the app (Ctrl+C in the dev terminal)
```

> 005 invents no SLA / assignment / document / billing values: seven items remain **BLOCKED** on
> business inputs / upstream slices (SLA thresholds → 007, assignment dimensions → 006, billing &
> document detail → 008, the "Limited" edit scope, saved-views-by-role, and the export-cap value) and
> are scaffolded as labelled placeholders/defaults, not final config. This guide exercises the
> operating surface with documented-default demo data.
