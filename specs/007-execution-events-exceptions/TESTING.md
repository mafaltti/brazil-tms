# Feature 007 — Self-test guide (Execution Events, Exceptions, SLA Risk & In-App Alerts)

How to stand up the local stack and exercise the execution-tracking write surface and the SLA/alert
engine. Host: Windows + PowerShell. Prereqs: Docker Desktop running, Node 20+/pnpm, `pnpm install`
already done. This slice builds on the trip domain (003), control tower (005), and dispatch (006).

What's different from earlier slices:

- **No Supabase Storage / bucket** this time (exception & event attachments are deferred to 008) — so
  setup is *simpler* than 004: there's no bucket to create.
- The worker now runs its **first scheduled cron job** — the **SLA sweep** (every 5 min by default).
  But because every milestone/exception/assignment/cancel mutation **recomputes SLA synchronously in
  its own transaction**, most manual checks work **with the app alone**. You only need the worker for
  the purely **time-based** triggers (a trip silently passing a window with no user action) and the
  periodic re-evaluation. See §5.7.
- Freshness is **polling** (TanStack Query) — there is no Realtime; lists refresh on an interval.

> Your local `.env` files already exist (gitignored): `infra/supabase/.env`, `apps/web/.env.local`,
> `packages/db/.env`, `workers/.env`. On a fresh machine, copy each `.env.example` and fill in (demo
> JWT keys are fine for local). 007 adds **no new required env var**; the sweep cadence is overridable
> via optional `SLA_SWEEP_CRON` in `workers/.env` (default `*/5 * * * *`).

## 1. Bring it up

```powershell
docker compose -f infra/supabase/docker-compose.yml up -d   # Postgres + GoTrue + gateway + Mailpit
# Wait until GoTrue is healthy:
curl http://localhost:8000/auth/v1/health                   # -> HTTP 200 {"name":"GoTrue",...}

pnpm --filter @brazil-tms/db db:migrate                     # applies 0006 (4 tables, 3 enums, trips/trip_events ALTERs)
pnpm --filter @brazil-tms/db db:seed:e2e                    # role accounts (table in §2)
pnpm --filter @brazil-tms/db db:seed:master-data           # customer "Shopee (Demo)" (DEMO-SHOPEE) + lanes + locations
pnpm --filter @brazil-tms/db db:seed:trip-domain           # sample trips across statuses (something to act on)
pnpm --filter @brazil-tms/db db:seed:reason-codes          # 007 exception reason codes (§3)
pnpm --filter @brazil-tms/db db:seed:sla-rules             # 007 one demo per-customer SLA rule (run AFTER master-data)
```

> `db:migrate` runs **all** migrations 001→0006. 0006 adds the four 007 tables (`reason_codes`,
> `exceptions`, `customer_sla_rules`, `alerts`), three enums, `trips.sla_reasons`, the
> `trip_events.exception_id` FK, and the `note` event type. It drops nothing.

**Run the app** (always) and **the worker** (only for §5.7 time-based alerts / the periodic sweep):

```powershell
# Terminal A — app (BFF + all execution screens) on http://localhost:3000
pnpm --filter @brazil-tms/web dev
# Terminal B — the worker (now also schedules the SLA sweep cron). Optional for §5.1–§5.6.
pnpm --filter @brazil-tms/workers start          # logs the import worker + the scheduled "sla.sweep"
```

> To watch the **time-based** SLA path quickly, set the sweep to every minute before starting the
> worker: add `SLA_SWEEP_CRON=* * * * *` to `workers/.env` (default is every 5 min). The sweep
> evaluates **active** (non-terminal) trips only; terminal trips are cleared synchronously the moment
> they close (completed/cancelled), so the sweep never revisits them.

- Mailpit (part of the stack, unrelated to 007): **http://localhost:8025**
- Host port 5432 taken? `SUPABASE_DB_PORT=5433` is already set in `infra/supabase/.env`.

## 2. Test accounts (from `db:seed:e2e`)

Passwords are per-account (see `packages/db/seed/e2e-accounts.ts`). 007 first-enforces three
pre-declared permission keys and reuses two — who can do what:

| Email | Password | Role | Milestones + Notes | Exceptions create/resolve | SLA-rule admin | Read board/alerts + ack |
|---|---|---|:--:|:--:|:--:|:--:|
| admin@braziltransports.com.br | `ChangeMe!Admin123` | Admin | ✅ | ✅ | ✅ | ✅ |
| opsmanager@braziltransports.com.br | `ChangeMe!Ops123` | Operations Manager | ✅ | ✅ | ✅ | ✅ |
| dispatcher@braziltransports.com.br | `ChangeMe!Dispatcher123` | Dispatcher | ✅ | ✅ | ❌ | ✅ |
| fleetcoord@braziltransports.com.br | `ChangeMe!Fleet123` | Fleet Coordinator | ❌ | ✅ | ❌ | ✅ |
| finance@braziltransports.com.br | `ChangeMe!Finance123` | Finance | ❌ | ❌ | ❌ | ✅ (read) |

Permission keys behind the columns: milestones/notes = `update_trip_status`; exceptions =
`create_exceptions` + `resolve_exceptions`; SLA-rule admin = `manage_commercial_data` (reused);
reads + alert acknowledge = `view_all_trips`.

> The two roles the catalog grants but the e2e seed does **not** create accounts for are **Control
> Tower** (same as Dispatcher for 007: milestones ✅ / exceptions ✅ / SLA ❌) and **Executive Viewer**
> (read-only, like Finance). To exercise them, change a user's role in the admin UI (`/admin/users`)
> or rely on the unit tests over `ROLE_PERMISSIONS`.
>
> Key distinctions worth testing: **Fleet Coordinator** can work exceptions but **cannot** record
> milestones/notes; **alert acknowledge** is a read-tier action (any `view_all_trips` role clears an
> alert); **SLA-rule admin** is Admin + Operations Manager only.

## 3. Seeded data (documented-default scaffolding — Constitution II)

- **Reason codes** (`db:seed:reason-codes`, idempotent on `code`): 12 defaults, one per EXC-004
  category — `DELAY`, `NO_SHOW` (high), `BREAKDOWN` (high), `DRIVER_ISSUE`, `CUSTOMER_DELAY`,
  `LOADING_DELAY`, `UNLOADING_DELAY`, `DOCUMENTATION`, `ACCIDENT` (high, party `force_majeure`),
  `ROUTE_DEVIATION`, `CANCELLATION` (high), `OTHER`. Each carries a default severity (`low/medium/high`)
  and default responsible party (the **high**-severity ones are what flip SLA to *At Risk*, see §5.3).
- **SLA rule** (`db:seed:sla-rules`): **one** customer-default rule for **Shopee (Demo)** (`DEMO-SHOPEE`)
  — pickup tolerance 15, delivery tolerance 30, confirmation cutoff 90, at-risk warning 60 (minutes).
  Every other customer falls back to the company `DEFAULT_SLA_POLICY` (warning 60 / tolerance 0 /
  confirm-cutoff 120 / time-in-status 120) and is reported **SLA sign-off blocked** (FR-022). Company
  defaults live in code (`@brazil-tms/shared` → `domain/sla-risk.ts`), not in a table.
- **Sample trips** (`db:seed:trip-domain`): trips spread across lifecycle statuses, so you have a
  `confirmed`/`at_origin` trip to drive milestones on and active trips to flag.

> Real per-customer reason vocabularies and SLA sign-off remain **BLOCKED** on customer files
> (PRD §29). High-severity exceptions raise risk regardless of customer; per-milestone planned times
> use the 120-min time-in-status default.

## 4. Automated tests

```powershell
pnpm lint ; pnpm typecheck ; pnpm build           # static gate (route exports, types, build)

# Unit only (no DB): the pure SLA evaluator, Zod schemas, permissions. Integration suites SKIP here.
pnpm test

# Integration (DB-backed): the suites un-skip ONLY when DATABASE_URL is set. They share the one dev DB,
# so run them serially with --no-file-parallelism.
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
pnpm exec vitest run --project web  --no-file-parallelism    # sla, sla-rules, exceptions, exceptions-read,
                                                              # alerts, trip-events, trips-read, trip-cancellation, …
pnpm exec vitest run --project workers --no-file-parallelism # sla-sweep (recompute + idempotent alert gen/auto-resolve)

# End-to-end (app running; e2e accounts seeded). Against the dev server:
$env:PLAYWRIGHT_BASE_URL='http://localhost:3000'
pnpm --filter @brazil-tms/web exec playwright test `
  e2e/execution-timeline.spec.ts e2e/exceptions.spec.ts e2e/sla-risk.spec.ts `
  e2e/alerts.spec.ts e2e/sla-rules.spec.ts e2e/execution-authz.spec.ts --workers=1
```

> Why `pnpm test` shows tests "skipped": every DB-backed suite is guarded by
> `describe.skipIf(!process.env.DATABASE_URL)`, so the default run stays green without a database. The
> SLA *evaluator* (`packages/shared`) is pure and **does** run in the unit pass — it is the single
> server-authoritative authority the BFF and the worker both call.

The 007 integration suites and what they cover:

| Suite | Covers |
|---|---|
| `apps/web/lib/trips/sla.test.ts` | `recomputeTripSla` per trigger, worst-state-wins, terminal clear, rule-vs-default |
| `apps/web/lib/trips/sla-rules.test.ts` | create/update + audit, precedence (lane > vehicle-type > default), cross-customer-lane reject |
| `apps/web/lib/trips/exceptions.test.ts` | create/update/transition lifecycle + high-sev alert sync + recompute |
| `apps/web/lib/trips/exceptions-read.test.ts` | exception list read model (Exception Management) |
| `apps/web/lib/trips/alerts.test.ts` | generate / auto-resolve / acknowledge / list (active filter) |
| `apps/web/lib/trips/trip-events.test.ts` | note + milestone events drive `recomputeTripSla` |
| `apps/web/lib/trips/trips-read.test.ts` | dashboard SLA metrics, "At risk" filter, alert/exception arrays |
| `apps/web/lib/trips/trip-cancellation.test.ts` | cancel sets fields/event/audit **and clears SLA + resolves alerts** |
| `workers/jobs/sla-sweep/*.test.ts` | sweep recompute over active trips + idempotent alert gen/auto-resolve |

## 5. Manual walkthrough (maps to the spec's user stories)

Open **http://localhost:3000**, sign in as **opsmanager@** (or admin@). UI is **pt-BR**. The worker
(Terminal B) is only needed for §5.7.

### 5.0 Authz (first-enforced keys)
- As **dispatcher@**: you can record milestones/notes and manage exceptions, but **SLA-rule admin** is
  hidden / `403` (`POST /api/customer-sla-rules` → 403).
- As **fleetcoord@**: you can create/resolve exceptions, but the **milestone/note** controls are
  disabled / `403` (`POST /api/trips/:id/status` → 403).
- As **finance@**: read-only — you can see the board, SLA states, and alerts (and may acknowledge
  alerts), but milestone/exception/SLA-rule writes are `403`.
- Logged out: any `/api/...` execution route → **401**.

### 5.1 US1 — interactive timeline: milestones & notes
1. Open a trip in **`confirmed`** (or `at_origin`) on the board (`/trips`) → **Trip Detail**
   (`/trips/[id]`). The timeline is now **interactive**.
2. Record the next **milestone** in order: `At Origin → [Loading] → Loaded → In Transit → At
   Destination → [Unloading] → Unloaded → Completed`. Each click appends a `status_change` event to
   the timeline and **recomputes SLA immediately** (Loading/Unloading are `status_change`, not new
   event types — D5). An illegal jump (e.g. Loaded before At Origin) is refused by 003's status
   machine (`ILLEGAL_TRANSITION`).
3. Add a free-form **note** → it appears on the timeline as a `note` event with **no** status change.
4. Both are audited (`trip.status_change` for milestones, `trip.note` for notes); the timeline is
   append-only — past entries cannot be edited or deleted. Entries show planned-vs-actual deltas vs
   the imported pickup/delivery windows.

### 5.2 US2 — exceptions lifecycle
1. On Trip Detail, open the **exception panel** → **create an exception**: pick a **reason code**
   (from §3) → its default severity + responsible party pre-fill (editable); add a description. The
   owner defaults to you (reassignable).
2. The exception opens in **Open**; transition it **Open ↔ Monitoring**, then **Resolve** (closure
   notes required → sets `resolved_at`) or **Cancel**. Resolved/Cancelled are **terminal** (no reopen).
   Each step is audited (`exception.create/update/resolve/cancel`).
3. Creating a **high-severity** exception (e.g. `BREAKDOWN`, `ACCIDENT`, `NO_SHOW`) flips the trip's
   SLA indicator to **At Risk** instantly (synchronous) **and** raises an in-app alert (§5.4);
   resolving the last open high-sev exception clears that reason and auto-resolves the alert.
4. **Exception Management** screen (`/exceptions`): the cross-trip queue with filters (severity,
   customer, lane, reason, owner, age) — confirm the one you created appears, then leaves the "open"
   view once resolved.

### 5.3 US3 — server-authoritative SLA risk
SLA state is **computed on the server** (never hand-set). It surfaces in four places:
1. **Board** (`/trips`): the SLA column shows **On Track / At Risk / Late** with reason chips.
2. **"At risk" filter/quick-view** on the board: narrows to flagged trips only.
3. **Trip Detail**: the SLA indicator + the list of fired reasons.
4. **Dashboard** (`/`): the SLA metrics (at-risk / active-exception / on-time widgets; **Breached** is
   unreachable in the MVP by design, D1).

Quick ways to make a trip non-On-Track **without** the worker (synchronous triggers):
- Create a **high-severity exception** (§5.2) → **At Risk** (`open_high_severity_exception`).
- A trip with no assignment past its confirmation-lead deadline → **At Risk** (`missing_assignment`);
  an assignment never confirmed in time → `missed_confirmation` (006 state, read-only here).
- **Worst-state-wins**: a Late window-miss plus an At-Risk exception ⇒ the trip shows **Late** with
  *both* reasons listed.

### 5.4 US4 — in-app alerts (six in-scope §17 cases)
1. The in-app **alerts surface** lists **active** alerts: `unassigned_within_window`,
   `unconfirmed_within_window`, `missed_origin_arrival`, `missed_departure`,
   `missed_destination_arrival`, and `high_severity_exception` (the last fires synchronously on
   exception create; the time-based ones via the sweep, §5.7).
2. **Acknowledge** one → it drops off the surface and the count decreases (any `view_all_trips` role
   can do this). The row persists as `acknowledged` server-side, so the same condition isn't
   re-alerted while still true (D3); when the underlying condition clears, the alert **auto-resolves**.
   No external channel (email/SMS/WhatsApp/webhook) is ever invoked; the two document/billing cases
   (7–8) are deferred to 008/009.

### 5.5 US5 — per-customer SLA rules (admin)
1. As **opsmanager@**/admin@, open **SLA-rule admin** (`/sla-rules`). You'll see the seeded
   **Shopee (Demo)** rule (§3).
2. Create a rule: pick a **customer** → the **lane** dropdown is filtered to **that customer's lanes**
   (a cross-customer lane is rejected — `NOT_FOUND`); set tolerances / confirmation cutoff / warning.
3. **Precedence** (most specific wins): lane-scoped > vehicle-type-scoped > customer-default; ties
   break on the latest `effective_start`; with no matching rule, `DEFAULT_SLA_POLICY` applies (customer
   SLA sign-off reported **blocked**). Change a rule, then re-check a trip's risk to see the new policy
   take effect.
4. As **dispatcher@**: SLA-rule admin is **not** available (reuses `manage_commercial_data`).

### 5.6 Cancellation clears SLA (regression guard)
When a trip that is currently **At Risk/Late** with an active alert is **cancelled**, its SLA state is
**cleared** (no stale At Risk/Late) and its active alerts **auto-resolve** — synchronously, because the
sweep never revisits terminal trips.

> ⚠️ `cancellation_options` ships **empty** (no seed script), so the manual cancel flow fails with
> `CANCELLATION_NOT_CONFIGURED` until you add at least one active `reason` and one active
> `billing_impact` row. The simplest way to verify this guard is the **automated test**, which seeds
> its own config:
> ```powershell
> $env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
> pnpm exec vitest run --project web --no-file-parallelism apps/web/lib/trips/trip-cancellation.test.ts
> ```
> (look for "cancelling clears the trip's SLA risk state and auto-resolves its active alerts"). To do it
> by hand, first add the config rows, e.g.:
> ```sql
> INSERT INTO cancellation_options (kind, code, label_pt, active) VALUES
>   ('reason', 'customer_request', 'Solicitação do cliente', true),
>   ('billing_impact', 'no_charge', 'Sem cobrança', true);
> ```
> then cancel an At-Risk trip and confirm its SLA indicator + alerts clear.

### 5.7 Time-based SLA + the worker sweep
Some risks fire only with the passage of time (no user action): **missed origin arrival**, **missed
departure**, **missed destination arrival**. To see them:
1. Set `SLA_SWEEP_CRON=* * * * *` in `workers/.env` and start the worker (Terminal B).
2. Ensure a trip has a **planned window in the past** while still active (use a sample trip, or edit a
   trip's planned pickup/delivery window to a past time).
3. Within a minute the sweep flips the trip's SLA state and generates the matching alert; clearing the
   condition (or the trip going terminal) auto-resolves it. The worker log prints a per-sweep summary
   (`duration_ms / evaluated / changed / alerts_created / alerts_resolved / errors`); it is per-trip
   fault-isolated (one bad trip is skipped, the sweep continues).

## 6. Tear down

```powershell
docker compose -f infra/supabase/docker-compose.yml down -v   # stop + wipe the DB volume
# stop the app (Ctrl+C in Terminal A) and the worker (Ctrl+C in Terminal B)
```

> `down -v` wipes the database; re-run the §1 migrate + seeds after a fresh bring-up. No Storage bucket
> to recreate this time. Customer reason-vocabulary and SLA sign-off remain **BLOCKED** on real files —
> this guide exercises the engine with documented-default scaffolding, not final customer configs.
