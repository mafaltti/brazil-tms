# Feature 006 — Self-test guide (Dispatch Assignment & Conflict Warnings)

How to stand up the local stack and test the dispatch/assignment surface. Host: Windows + PowerShell.
Prereqs: Docker Desktop running, Node 20+/pnpm, `pnpm install` already done.

Unlike slice 004, this slice is back to **ONE process**: there is **no worker** and **no Supabase
Storage bucket** to create. Assignment + the §19.2 conflict/eligibility checks are **synchronous,
indexed BFF operations** — the server is the single source of conflict authority, and freshness is
**polling** (the Dispatch Board / Trip Detail poll every ~30 s, the dashboard every ~60 s; no Realtime).
006 adds **one table** (`trip_assignments`, migration `0005`) and **no new enum, permission key,
package, or worker**; it **enforces the pre-declared `assign_resources` key for the first time**.

> Your local `.env` files already exist (gitignored): `infra/supabase/.env`, `apps/web/.env.local`,
> `packages/db/.env`. Each already has `SUPABASE_SERVICE_ROLE_KEY` / `*_SUPABASE_URL` / `DATABASE_URL`.
> On a fresh machine, copy each `.env.example` and fill in (demo JWT keys are fine for local).

## 1. Bring it up

```powershell
docker compose -f infra/supabase/docker-compose.yml up -d   # Postgres + GoTrue + gateway + Storage + Mailpit
curl http://localhost:8000/auth/v1/health                   # -> HTTP 200 {"name":"GoTrue",...}

pnpm --filter @brazil-tms/db db:migrate                     # 001..005 — 0005 adds ONE table `trip_assignments`
pnpm --filter @brazil-tms/db db:seed                        # first admin
pnpm --filter @brazil-tms/db db:seed:e2e                    # role accounts (table in §2)
pnpm --filter @brazil-tms/db db:seed:master-data            # customer "Shopee (Demo)", CD-SP/CD-RJ, 1 carrier, 2 vehicles
pnpm --filter @brazil-tms/db db:seed:trip-domain            # 1 sample trip (DEMO-TRIP-001, status `received`)
```

**Run ONE process** (single terminal) — no worker:

```powershell
pnpm --filter @brazil-tms/web dev          # app (BFF + UI) on http://localhost:3000
```

- Host port 5432 taken? `SUPABASE_DB_PORT=5433` is already set in `infra/supabase/.env`; `DATABASE_URL`
  uses `:5433`.
- Mailpit (part of the stack, unused by 006): http://localhost:8025

## 2. Test accounts (from `db:seed:e2e`)

006 enforces **`assign_resources`** for the first time — held by **Admin, Operations Manager,
Dispatcher, Fleet Coordinator**. Trip **reads** (board / detail / dashboard, incl. the new assignment
fields) stay on `view_all_trips` (every internal role). Override of a WARN needs only
`assign_resources`; **no role can override a BLOCK**.

| Email | Password | Role | Can assign? | Can read? |
|---|---|---|:--:|:--:|
| admin@braziltransports.com.br | `ChangeMe!Admin123` | Admin | ✅ | ✅ |
| opsmanager@braziltransports.com.br | `ChangeMe!Ops123` | Operations Manager | ✅ | ✅ |
| dispatcher@braziltransports.com.br | `ChangeMe!Dispatcher123` | Dispatcher | ✅ | ✅ |
| fleetcoord@braziltransports.com.br | `ChangeMe!Fleet123` | Fleet Coordinator | ✅ | ✅ |
| finance@braziltransports.com.br | `ChangeMe!Finance123` | Finance | ❌ (403 / no nav) | ✅ |

## 3. Prepare assignable data (one-time SQL)

> **Why SQL?** The seeds give 2 vehicles + 1 carrier but **no drivers**, and the sample trip is
> `received`. Assignment runs from a **`validated`** trip and needs **driver + vehicle** (+ carrier if
> subcontracted). There is **no UI yet to transition `received → validated`** (that triage surface is a
> later slice), so we seed a couple of `validated` trips and some drivers directly — exactly what the
> integration tests do. Drivers *can* alternatively be created in the UI (**Recursos → Motoristas**,
> `/resources/drivers`, as Ops Manager/Admin/Fleet Coordinator); the trip status still needs the SQL.

Confirm the DB container name with `docker ps` (default below), then paste the block. It is **idempotent**
(safe to re-run):

```powershell
docker exec -i brazil-tms-supabase-db-1 psql -U postgres -d postgres -c @'
-- Drivers (none are seeded): one clean, one BLOCKED, one with an EXPIRED license (for §19.2 demos).
INSERT INTO drivers (name, ownership_type, status, license_expiry)
SELECT v.name, v.ot::ownership_type, v.st::resource_status, v.lx::date
FROM (VALUES
  ('Motorista Demo',        'owned', 'active',  '2030-01-01'),
  ('Motorista Bloqueado',   'owned', 'blocked', '2030-01-01'),
  ('Motorista Doc Vencido', 'owned', 'active',  '2020-01-01')
) AS v(name, ot, st, lx)
WHERE NOT EXISTS (SELECT 1 FROM drivers d WHERE d.name = v.name);

-- Make the seeded trip assignable: received -> validated + a pickup window.
UPDATE trips
   SET current_status = 'validated',
       planned_pickup_window_start = now() + interval '1 day',
       planned_delivery_window_end = now() + interval '1 day 8 hours'
 WHERE external_trip_id = 'DEMO-TRIP-001';

-- Two more validated trips on the demo customer/locations: DEMO-DISP-002 (a separate-day board entry)
-- and DEMO-DISP-003 (window OVERLAPS DEMO-TRIP-001 -> for the schedule_conflict demo).
INSERT INTO trips (customer_id, external_trip_id, origin_location_id, destination_location_id,
                   current_status, original_plan, planned_vehicle_type,
                   planned_pickup_window_start, planned_delivery_window_end)
SELECT c.id, v.ext, o.id, d.id, 'validated', '{}'::jsonb, 'truck', v.s, v.f
FROM customers c
  JOIN locations o ON o.customer_id = c.id AND o.code = 'CD-SP'
  JOIN locations d ON d.customer_id = c.id AND d.code = 'CD-RJ'
  CROSS JOIN (VALUES
    ('DEMO-DISP-002', now() + interval '2 days',       now() + interval '2 days 8 hours'),
    ('DEMO-DISP-003', now() + interval '1 day 4 hours', now() + interval '1 day 12 hours')
  ) AS v(ext, s, f)
WHERE c.customer_code = 'DEMO-SHOPEE'
ON CONFLICT (customer_id, external_trip_id) WHERE external_trip_id IS NOT NULL DO NOTHING;
'@
```

After this you have, on **Shopee (Demo)** (CD-SP → CD-RJ):

- **3 validated trips** — `DEMO-TRIP-001`, `DEMO-DISP-002`, `DEMO-DISP-003` (all planned `truck`).
- **3 drivers** — *Motorista Demo* (ok), *Motorista Bloqueado* (status blocked → BLOCK), *Motorista Doc
  Vencido* (license expired → BLOCK).
- **2 vehicles** (from `db:seed:master-data`) — **ABC1D23** (truck, owned) and **XYZ4E56** (carreta,
  **subcontracted** → carrier *Transportes Parceiros (Demo)*).

## 4. Automated tests

```powershell
pnpm lint ; pnpm typecheck ; pnpm build           # static gate (route exports, types, prod build)

# Unit only — pure, no DB (eligibility evaluator, policy, Zod schemas, permissions, transition legality).
pnpm test                                          # DB-backed suites SKIP here (see note below)

# Integration: the DB-backed suites un-skip ONLY when DATABASE_URL is set.
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
pnpm exec vitest run --project shared              # evaluateAssignmentEligibility (every §19.2 check + archived BLOCK), policy, requiredResourcesFor, trip-assignment Zod
pnpm exec vitest run --project web apps/web/lib/trips
#   ^ assign/confirm/reassign/unassign/checkAssignment + gatherEligibilityContext overlap query;
#     single-current-assignment (23505) guard; reassign status guards (ILLEGAL/STALE); archived BLOCK;
#     board assignment filters + dashboard unassigned count + the "Unassigned" view preset.

# End-to-end (Playwright). Reset accounts first, then run ONLY the dispatch specs.
pnpm --filter @brazil-tms/db db:seed:e2e
$env:SUPABASE_URL='http://localhost:8000'
$env:SUPABASE_SERVICE_ROLE_KEY=((Select-String -Path infra/supabase/.env -Pattern '^SERVICE_ROLE_KEY=').Line -split '=',2)[1]
$env:PLAYWRIGHT_BASE_URL='http://localhost:3000'
pnpm --filter @brazil-tms/web exec playwright test e2e/dispatch-assignment.spec.ts e2e/dispatch-warnings.spec.ts e2e/dispatch-override.spec.ts e2e/dispatch-reassign.spec.ts e2e/dispatch-board.spec.ts e2e/dispatch-authz.spec.ts --workers=1
```

> Why `pnpm test` shows tests "skipped": every DB-backed suite is guarded by
> `describe.skipIf(!process.env.DATABASE_URL)`, so the default run stays green without a database. The
> dispatch specs **seed their own trips/resources** (they don't need the §3 SQL).
>
> ⚠️ **Stale dev server caveat (real gotcha).** A long-running `pnpm dev` holds broken HMR state after
> cross-package edits and can produce **false e2e failures** (e.g. a page that won't render). For a
> trustworthy run, point Playwright at a **fresh production build** instead of the dev server:
> ```powershell
> pnpm build
> pnpm --filter @brazil-tms/web exec next start -p 3100      # separate terminal
> $env:PLAYWRIGHT_BASE_URL='http://localhost:3100'           # then run the playwright command above
> ```

## 5. Manual walkthrough (maps to the spec's User Stories / Success Criteria)

Open **http://localhost:3000**, sign in as **opsmanager@** (or dispatcher@ / fleetcoord@ / admin@). UI is
**pt-BR**. New sidebar entry: **Expedição** (`/dispatch`).

1. **Authz — `assign_resources` only.** Sign in as **finance@** → no **Expedição** in the nav; the
   assignment panel on a trip shows no write controls. Finance can still **read** every assignment field
   (board column, detail, dashboard). (Server-authoritative: a direct `POST /api/trips/:id/assignment`
   as Finance → **403**, even with a valid body; logged out → **401**.)
2. **US1 — assign & confirm (SC-003, SC-005).** As **opsmanager@**, open **Viagens** (`/trips`), click
   `DEMO-TRIP-001` → the **Atribuição de recursos** panel. Pick **Motorista Demo** + vehicle **ABC1D23**
   → **Atribuir**. The trip becomes **Atribuída** (`assigned`), the panel shows assigned-by / assigned-at,
   and there is **exactly one** current assignment. Click **Confirmar** → **Confirmada** (`confirmed`) with
   a confirmation timestamp. Open the audit history → **Viagem atribuída** / **Atribuição confirmada**.
   Try assigning with only a driver (no vehicle) → **409 Atribuição incompleta** (`INCOMPLETE_ASSIGNMENT`).
3. **US2 — conflict & eligibility warnings (server-authoritative).** On a fresh validated trip
   (`DEMO-DISP-002`), as you pick resources the panel shows **inline findings** with severity (the dry-run
   `…/assignment/check` runs server-side):
   - **Motorista Bloqueado** → **resource_status BLOCK** (`Motorista bloqueado.`) — save is refused.
   - **Motorista Doc Vencido** → **documentation BLOCK** (`Documentação vencida.`).
   - vehicle **XYZ4E56** (carreta) on a `truck`-planned trip → **vehicle_type WARN** (`Tipo do veículo
     difere…`); and because XYZ4E56 is **subcontracted**, saving without a carrier → **409
     INCOMPLETE_ASSIGNMENT** (carrier required).
   - **schedule_conflict WARN**: assign *Motorista Demo* to `DEMO-TRIP-001` (step 2), then on
     `DEMO-DISP-003` (overlapping window) pick *Motorista Demo* → **schedule_overlap** WARN.
   A **BLOCK prevents saving** and cannot be bypassed; confirm the server still refuses a BLOCK even via a
   direct API call (devtools → Network, or curl) — the UI never owns authority.
4. **US3 — override a WARN with a reason.** Trigger a WARN (e.g. assign carreta **XYZ4E56** + carrier
   *Transportes Parceiros (Demo)* to a truck trip → `type_mismatch` WARN). Save without a reason → **409**
   and the panel prompts for **Motivo da exceção**. Enter a reason → it completes; the reason is stored on
   the assignment and shown in the audit history. A **BLOCK is never overridable** (no reason field appears
   for a BLOCK; a direct API attempt → `409 ASSIGNMENT_BLOCKED`).
5. **US4 — reassign / unassign, history retained (SC-005).** On the now-`assigned` `DEMO-TRIP-001`,
   **Reatribuir** to a different driver/vehicle → there is still **exactly one** current assignment (the new
   one), the prior is kept as **history** (superseded + timestamp), and the **status is unchanged**;
   eligibility re-runs for the new resources. Then **Desatribuir** → status returns to **Validada**
   (`validated`), the prior assignment retained. (Reassignment is only allowed while `assigned`/`confirmed`
   — the server rejects it otherwise.)
6. **US5 — Dispatch Board & board integration (SC-006).** Open **Expedição** (`/dispatch`) → the
   **unassigned-by-pickup** queue; assign/confirm from it. In **Viagens** (`/trips`): the **Atribuição**
   column shows ✓/✗ + the assigned resource names; the **Não atribuídas** quick-view scopes to unassigned
   trips; the assigned-driver / vehicle / carrier filters narrow the list; a per-row **Atribuir** action
   (on an unassigned `validated` row) opens the assignment form. On the home dashboard (**/**), the
   **Viagens sem atribuição** widget shows the live count and deep-links to the Unassigned view. Leave any
   surface open → it refreshes every ~30 s (polling; no Realtime).

### Bonus — the PR-review hardening (verify the fixes)

- **Archived resources are blocked server-side.** Archive *Motorista Demo* (**Recursos → Motoristas →
  Arquivar**, or `UPDATE drivers SET archived_at = now() WHERE name = 'Motorista Demo';`). The picker now
  **hides** it (UI), and a **direct** `POST …/assignment` / `…/assignment/check` with that driver id →
  **`driver_archived` BLOCK** (`Motorista arquivado.`). Covers archived driver/vehicle/trailer.
- **Reassign respects the status machine.** A direct `POST …/assignment` with `expectedFromStatus` not in
  `{assigned, confirmed}` → **409 ILLEGAL_TRANSITION**; a mismatching `expectedFromStatus` → **409
  STALE_TRANSITION** (no silent reassign of an in-flight trip).
- **Missing trip → 404.** Any assignment write/check against an unknown trip id → **404 NOT_FOUND** (not 409).

(These edges are also covered by `e2e/dispatch-warnings.spec.ts`, `e2e/dispatch-authz.spec.ts`, and the
`apps/web/lib/trips/*` integration tests.)

## 6. Tear down

```powershell
docker compose -f infra/supabase/docker-compose.yml down -v   # stop + wipe the DB volume
# stop the app (Ctrl+C). If you started a prod server for e2e (port 3100), stop that too.
```

> `down -v` wipes the DB, so re-run the §1 migrate/seed steps and the §3 SQL after a fresh bring-up.
> The §3 data (drivers + `validated` trips) is **documented-default scaffolding** to exercise the
> dispatch engine, not real customer data; the carrier approved-for-customer/lane rule, per-customer
> severity overrides, and the broader ownership policy remain out of MVP scope (config defaults).
