# Feature 003 — Self-test guide (Trip Domain, Status Machine & Audit Semantics)

How to stand up the local stack and test what's implemented in slice 003. Host: Windows + PowerShell.
Prereqs: Docker Desktop running, Node 20+/pnpm, `pnpm install` already done, and features 001/002 in
place (this slice builds on them).

> **Read this first — 003 is a foundational, mostly-headless slice.** It ships the durable trip domain
> (3 tables, 4 enums, the single status machine, the cancellation config) plus a **read-only trip
> inspector** (`GET /api/trips`, `GET /api/trips/:id`). The *mutating* operations — create, transition,
> plan-update, cancel — are **server-side service functions with no UI and no write endpoint in this
> slice** (the operational screens belong to slices 004–007). So you exercise mutations through the
> **integration test suite** and inspect the results through the **inspector** and **psql**.

> Your local `.env` files already exist (gitignored): `infra/supabase/.env`, `apps/web/.env.local`,
> `packages/db/.env`. On a fresh machine, copy each `.env.example` and fill in (demo JWT keys are fine
> for local).

## 1. Bring it up

```powershell
docker compose -f infra/supabase/docker-compose.yml up -d        # Postgres + GoTrue + gateway + Mailpit
curl http://localhost:8000/auth/v1/health                        # -> HTTP 200 when GoTrue is ready

pnpm --filter "@brazil-tms/db" db:migrate          # 001 + 002 + 003 migrations (incl. the trip_events REVOKE)
pnpm --filter "@brazil-tms/db" db:seed:e2e         # the 7 test accounts in §2 (admin = active, ready)
pnpm --filter "@brazil-tms/db" db:seed:master-data # DEMO-SHOPEE customer + locations + lane (anchors trips)
pnpm --filter "@brazil-tms/db" db:seed:trip-domain # cancellation_options (billing_impact) + sample trip DEMO-TRIP-001

pnpm --filter "@brazil-tms/web" dev                # app on http://localhost:3000
```

What the 003 migration (`0002_*.sql`) adds: tables `trips`, `trip_events`, `cancellation_options`;
enums `trip_status` (18), `trip_event_type`, `trip_event_source`, `cancellation_responsible_party`;
and a **manual** `REVOKE UPDATE, DELETE ON trip_events FROM PUBLIC` (append-only, like `audit_logs`).

> `db:seed:trip-domain` seeds `billing_impact` codes (`no_charge`, `cancellation_fee`, `manual_review`)
> as **labeled scaffolding** and leaves cancellation **`reason`** codes **empty on purpose** — they're
> business-blocked, so a real cancellation fails with `CANCELLATION_NOT_CONFIGURED` until business
> supplies them. The integration tests seed their own.

## 2. Test accounts (from `db:seed:e2e`)

Trip-domain access is the **`manage_trips`** permission — granted to **Admin** and **Operations
Manager** only in this slice (Dispatcher / Control Tower / Finance get their trip permissions in later
slices). The inspector enforces it.

| Email | Password | Role | `manage_trips`? |
|---|---|---|---|
| admin@braziltransports.com.br | `ChangeMe!Admin123` | Admin | ✅ yes |
| opsmanager@braziltransports.com.br | `ChangeMe!Ops123` | Operations Manager | ✅ yes |
| finance@braziltransports.com.br | `ChangeMe!Finance123` | Finance | ❌ no (→ 403) |
| dispatcher@braziltransports.com.br | `ChangeMe!Dispatcher123` | Dispatcher | ❌ no (→ 403) |
| fleetcoord@braziltransports.com.br | `ChangeMe!Fleet123` | Fleet Coordinator | ❌ no (→ 403) |
| temppw@braziltransports.com.br | `ChangeMe!Temp123` | Dispatcher | (must change password) |
| disabled@braziltransports.com.br | `ChangeMe!Disabled123` | Dispatcher | (disabled → 401) |

## 3. Automated tests — the primary gate for this headless slice

```powershell
pnpm lint ; pnpm typecheck ; pnpm build           # static gate

# Unit (no DB): the status machine, billingStatus projection, critical-field set, permission matrix
pnpm --filter "@brazil-tms/shared" test            # incl. the 55-test trip-status suite

# Service-layer INTEGRATION (needs the dev DB). MUST set DATABASE_URL and run from the repo ROOT with
# --project web (the @/ alias + server-only stub live in the root vitest.workspace.ts):
$env:DATABASE_URL = "postgres://postgres:postgres@localhost:5433/postgres"
pnpm exec vitest run --project web lib/trips/      # the 7 trip suites (34 tests) — see the map below

# Everything at once (335 tests when DATABASE_URL is set; without it the integration tests SKIP):
$env:DATABASE_URL = "postgres://postgres:postgres@localhost:5433/postgres" ; pnpm test
```

The seven `lib/trips/*.test.ts` suites ARE the mutation walkthrough — read the test names as you run
them; each maps to a behavior and a Success Criterion:

| Suite | What it proves | SC |
|---|---|---|
| `trips-service.test.ts` | create stores the immutable `original_plan` + status `received`; an executed `origin_arrived` event leaves the `planned_*` windows untouched and is retrievable separately | SC-002, SC-006 |
| `trip-transitions.test.ts` | only declared transitions are allowed; `received→in_transit` is rejected with status unchanged; a stale `expectedFromStatus` → 409; each transition writes exactly one event + one audit atomically; the disputed round-trip | SC-001, SC-003 |
| `trip-plan.test.ts` | an accepted plan edit changes the live field, preserves `original_plan`, writes one `trip.plan_update` audit; a post-`confirmed` edit without review → `REVIEW_REQUIRED`; concurrent edits don't stale the audit | SC-002, SC-003 |
| `trip-cancellation.test.ts` | cancel needs all five inputs; missing `responsibleParty` → 400; empty reason config → `CANCELLATION_NOT_CONFIGURED`; `completed` → `NOT_CANCELLABLE`; cancellable through `at_destination` | SC-001, SC-004 |
| `trip-audit.test.ts` | every critical change = exactly one immutable audit row; a non-critical edit writes none | SC-003 |
| `trip-audit-immutability.test.ts` | direct `UPDATE`/`DELETE` on `trip_events` / `audit_logs` is rejected by DB privilege; `original_plan` never changes across plan updates | SC-002, SC-003 |
| `trip-billing-phase.test.ts` | `completed→billing_pending→billing_ready→billed` via the same machine; `billing_pending→billed` rejected; `billingStatus` tracks `current_status` | SC-005 |

### End-to-end (the read-only inspector)

The single e2e spec (`trips-inspector.spec.ts`) asserts the inspector's auth + payload shape.
**Run it against a production build** (not `next dev`, whose on-demand compile times out), and
**re-seed e2e accounts first** (the suite's role-change tests in 001 can pollute the seeded admin):

```powershell
pnpm --filter "@brazil-tms/db" db:seed:e2e
pnpm --filter "@brazil-tms/web" build ; pnpm --filter "@brazil-tms/web" start   # in one terminal
# in another terminal (app already running):
$env:DATABASE_URL = "postgres://postgres:postgres@localhost:5433/postgres"
$env:PLAYWRIGHT_BASE_URL = "http://localhost:3000"
pnpm --filter "@brazil-tms/web" exec playwright test e2e/trips-inspector.spec.ts --workers=1
```

## 4. Manual walkthrough (maps to the spec's Success Criteria)

### 4a. The read-only inspector — auth + the verification view

With the app running and signed-in sessions captured as cookie jars (PowerShell `curl.exe`):

```powershell
# No session → 401
curl.exe -s -o NUL -w "%{http_code}`n" http://localhost:3000/api/trips                       # -> 401

# Sign in (saves cookies). Admin & Ops Manager have manage_trips; Finance does not.
curl.exe -s -c admin.txt   -o NUL -X POST http://localhost:3000/api/auth/sign-in -H "Content-Type: application/json" -d '{\"email\":\"admin@braziltransports.com.br\",\"password\":\"ChangeMe!Admin123\"}'
curl.exe -s -c finance.txt -o NUL -X POST http://localhost:3000/api/auth/sign-in -H "Content-Type: application/json" -d '{\"email\":\"finance@braziltransports.com.br\",\"password\":\"ChangeMe!Finance123\"}'

# Finance → 403 (authenticated but lacks manage_trips)
curl.exe -s -o NUL -w "%{http_code}`n" -b finance.txt http://localhost:3000/api/trips         # -> 403

# Admin → 200: list (newest first), each with the derived billingStatus
curl.exe -s -b admin.txt "http://localhost:3000/api/trips"                                     # -> { items: [ { externalTripId: "DEMO-TRIP-001", currentStatus: "received", billingStatus: null, ... } ] }

# Admin → detail: trip + original_plan + planned_* + billingStatus + recent events + recent audit
curl.exe -s -b admin.txt "http://localhost:3000/api/trips?q=DEMO-TRIP-001"                     # copy the "id"
curl.exe -s -b admin.txt "http://localhost:3000/api/trips/<paste-id>"
```

You can also just browse `http://localhost:3000/api/trips` in a logged-in browser tab (sign in via the
001 login page first). What to confirm: the list/detail return the single `currentStatus`, the **derived
`billingStatus`** (null for a non-billing status), the immutable `originalPlan`, the live `planned_*`
fields, and the `events` + `audit` arrays (**SC-005, SC-006**, "minimal internal/admin visibility").
The seeded `DEMO-TRIP-001` is a minimal example with 0 events/audit; running the integration suite (§3)
creates trips with full event/audit history you can also inspect.

### 4b. Drive the lifecycle (mutations) — via the integration suite

Because this slice exposes no write endpoints, run the suites in §3 and read them as a live
demonstration: create → planned-vs-executed separation, the enforced status machine, plan updates with
the original preserved, cancellation validation, and the billing-phase projection. The table in §3 maps
each to its Success Criterion (**SC-001…SC-006**).

### 4c. Inspect the data directly (psql) — see the model and the guarantees

```powershell
$db = "brazil-tms-supabase-db-1"

# The three new tables + the 18-value status enum
docker exec $db psql -U postgres -d postgres -c "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('trips','trip_events','cancellation_options') ORDER BY 1;"
docker exec $db psql -U postgres -d postgres -c "SELECT unnest(enum_range(NULL::trip_status));"

# Config-driven cancellation: billing_impact scaffolding present, reason EMPTY (business-blocked)
docker exec $db psql -U postgres -d postgres -c "SELECT kind, code, label_pt, active FROM cancellation_options ORDER BY kind, sort_order;"

# Planned vs executed on the sample trip: original_plan (immutable) + live planned_* columns
docker exec $db psql -U postgres -d postgres -c "SELECT external_trip_id, current_status, original_plan, planned_vehicle_type FROM trips WHERE external_trip_id='DEMO-TRIP-001';"
```

**Append-only enforcement (SC-003).** The app connects as the `postgres` superuser, which *bypasses*
the `REVOKE` — so to *feel* the guarantee, drop superuser with `SET ROLE` and try to tamper:

```powershell
docker exec $db psql -U postgres -d postgres -c "CREATE ROLE probe NOLOGIN; GRANT USAGE ON SCHEMA public TO probe; GRANT SELECT, INSERT ON public.trip_events TO probe; SET ROLE probe; DELETE FROM public.trip_events;"
# -> ERROR: permission denied for table trip_events   (append-only holds for any non-superuser)
```

The whole batch runs in one implicit transaction, so the failing `DELETE` **rolls it back** — the
`probe` role is auto-removed and nothing persists (no cleanup needed). The same `REVOKE` protects
`audit_logs`. Try `UPDATE public.trip_events SET notes='x';` under the role for the same result.

## 5. Tear down

```powershell
# stop the dev/prod server with Ctrl+C in its terminal
docker compose -f infra/supabase/docker-compose.yml down -v   # stop + wipe the DB volume
```

> **Note on re-runs.** The e2e/integration suites self-clean their own rows, but the 001 admin-UI e2e
> tests mutate roles; if admin-gated pages start 403-ing, the seeded admin's role was polluted — just
> re-run `pnpm --filter "@brazil-tms/db" db:seed:e2e` to repair it. For a fully clean slate, `down -v`
> then re-migrate + re-seed.
