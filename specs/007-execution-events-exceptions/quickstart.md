# Quickstart: Execution Events, Exceptions, SLA Risk, and In-App Alerts (007)

**Feature**: 007-execution-events-exceptions | **Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Research**: [research.md](./research.md) · **Data model**: [data-model.md](./data-model.md) · **Contracts**: [contracts/](./contracts/)

This slice turns the control tower into a **live operating board**: record execution milestones through 003's transition service, log/work **exceptions** (Open↔Monitoring → Resolved/Cancelled, terminal), compute **server-authoritative SLA risk** (On Track / At Risk / Late / Breached) written to `trips.sla_status` + the new `trips.sla_reasons text[]`, and generate idempotent in-app **alerts** for the six in-scope §17 cases. It reuses 001 (auth/audit/i18n) + 002 (customers) + 003 (trip model / status machine / `transitionTripStatus` / append-only `trip_events`) + 005 (board/detail/dashboard read models + UI shell) + 006 (assignment / confirmed-at state). It adds **four tables** (`reason_codes`, `exceptions`, `customer_sla_rules`, `alerts`), **three enums** (`exception_status`, `exception_severity`, `exception_responsible_party`), one `trip_event_type` member (`note`), and the **first ever scheduled worker job** (an SLA sweep on the existing pg-boss queue). **No new permission key, no new package, no new worker process** — it first-enforces `update_trip_status` / `create_exceptions` / `resolve_exceptions` and reuses `manage_commercial_data`.

## Prerequisites (same stack as 001–006)

```powershell
pnpm install
docker compose -f infra/supabase/docker-compose.yml up -d   # Supabase (Postgres/Auth/Storage), Caddy gateway
curl http://localhost:54321/auth/v1/health                  # GoTrue healthy
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
pnpm db:migrate                                             # 001–006 migrations (through 0005_*)
pnpm db:seed                                               # admin account
pnpm db:seed:master-data                                   # customers / locations / lanes
pnpm db:seed:trip-domain                                   # sample trips incl. some `confirmed` (milestone-ready) + `validated`/`assigned`
```

## Apply this feature's migration

007 adds three enums + four tables and ALTERs `trips` (+ `sla_reasons text[]`, CHECK on `sla_status`) and `trip_events` (wire the `exception_id` FK). After editing the new schema files (`packages/db/schema/{reason-codes,exceptions,customer-sla-rules,alerts}.ts`, plus the `trips`/`trip-events` ALTERs and the new `note` `trip_event_type` member) and re-exporting them from `packages/db/schema/index.ts`:

```powershell
pnpm --filter "@brazil-tms/db" db:generate                # emit 0006_*.sql (CREATE TYPE x3 + CREATE TABLE x4 + ALTER trips/trip_events)
# Hand-verify the generated 0006_*.sql before applying (drizzle-kit needs manual confirmation here):
#   (a) trip_events.exception_id FK on the pre-existing column → exceptions(id) ON DELETE no action
#   (b) trips_sla_status_ck CHECK (sla_status IS NULL OR sla_status IN ('on_track','at_risk','late','breached'))
#   (c) sla_reasons emits as text[] (the FIRST array column in packages/db — no prior example)
#   (d) the partial-unique alerts_trip_case_open_uq ON (trip_id, alert_case) WHERE state IN ('active','acknowledged')
pnpm --filter "@brazil-tms/db" db:migrate                 # apply 0006_*.sql
```

**No `REVOKE` step** for `reason_codes` / `exceptions` / `customer_sla_rules` / `alerts` — they **mutate** (status, owner, closure, rule edits, acknowledge/resolve) like `trip_assignments`, so they are NOT append-only. `trip_events` **keeps its existing REVOKE** (still insert+select only). `alert_case` / `alert_state` / `reason_codes.category` / `sla_status` are CHECK-constrained `text`, not enums (so 008/009 can add alert cases without a `CREATE TYPE` migration).

## Seed reason codes + a customer SLA rule + company defaults

```powershell
pnpm --filter "@brazil-tms/db" db:seed:reason-codes        # one labeled-scaffolding row per EXC-004 category (12) with default_severity / default_responsible_party
pnpm --filter "@brazil-tms/db" db:seed:sla-rules           # one example customer_sla_rules row (so the evaluator uses it for that customer; others fall back to DEFAULT_SLA_POLICY → SLA sign-off blocked)
```

- **Reason codes** seed as **labeled scaffolding** (Constitution II): one default per EXC-004 category (`delay, no_show, breakdown, driver_issue, customer_delay, loading_delay, unloading_delay, documentation, accident, route_deviation, cancellation, other`) — NOT final business sign-off (mirrors 003's `cancellation_options` gap). Unlike `cancellation_options` (seeds zero rows), 007 seeds these so the exception flow is demonstrable end-to-end.
- **Company defaults** are **not** a DB row — they are `DEFAULT_SLA_POLICY` in `@brazil-tms/shared` (`domain/sla-risk.ts`): at-risk warning window **60 min**, on-time pickup/delivery tolerance **0 min** (window edge = cutoff), confirmation cutoff lead time **120 min** before pickup, time-in-status threshold (loading/departure) **120 min**. A `customer_sla_rules` row overrides these per customer/lane/vehicle-type.
- Any customer with **no** matching `customer_sla_rules` row is evaluated on `DEFAULT_SLA_POLICY` and reported **SLA sign-off blocked** (FR-022 / SC-008) — verified in US5.

## Run the app AND the worker

007 is the **first slice that needs the worker running for its own feature** (the ~5-min SLA sweep). Run both processes (separate terminals), both with `DATABASE_URL` set:

```powershell
# Terminal 1 — Next.js app (BFF + UI). Synchronous on-change SLA recompute + synchronous high-sev-exception alert live here.
pnpm dev

# Terminal 2 — the single Node worker (pg-boss). Activates the FIRST scheduled job: the SLA sweep.
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
pnpm --filter "@brazil-tms/workers" start                 # or `... dev` for tsx watch
```

The worker registers the sweep via pg-boss's built-in cron (`boss.schedule(...)` — STACK §3.11, no separate scheduler). Default cadence **~5 min, configurable** via `SLA_SWEEP_CRON` (add to `workers/.env` for local dev, and to the `worker` service `environment:` block in `infra/supabase/docker-compose.yml` for the container). Each sweep emits a structured per-sweep summary log (`duration_ms`, `evaluated`, `changed`, `alerts_created`, `alerts_resolved`, `errors`) + a last-run heartbeat — watch Terminal 2 to confirm it is sweeping. The sweep recomputes `sla_status`/`sla_reasons` and generates/auto-resolves alerts over **active (non-terminal) trips only**, chunked (≤200/batch), with per-trip fault isolation (try/catch — skip-and-continue) and per-trip `SELECT … FOR UPDATE`.

In dev you do **not** need the Docker `worker` container — run it via `pnpm --filter @brazil-tms/workers start`. (To exercise the containerized worker: `docker compose -f infra/supabase/docker-compose.yml up worker` once its image is built.)

Sign in (Ops Manager / Dispatcher / Control Tower hold `update_trip_status`/`create_exceptions`/`resolve_exceptions`; Ops Manager + Admin hold `manage_commercial_data` for SLA rules) and open: a `confirmed` trip's **/trips/:id** (interactive timeline + exception panel + SLA indicator + alerts), **/trips** (Control Tower — SLA "At risk" view / row indicator), **/exceptions** (Exception Management), and **/** (Home Dashboard — at-risk / active-exceptions / on-time widgets).

## Verify the feature (US-by-US)

1. **US1 — Record milestones & read the timeline**: open a `confirmed` trip's detail. From the **interactive timeline** advance the milestones in order: **At Origin → (Loading) → Loaded → In Transit → At Destination → (Unloading) → Unloaded → Completed** (Loading/Unloading optional). Each advance goes through `transitionTripStatus` → the trip status changes and a `trip_events` row records actor, source (`operator_manual`), timestamp, and previous/new status (EVT-002, automatic — no separate step). The timeline lists events **chronologically** with **planned-vs-actual** deltas vs the imported pickup/delivery windows. Add a **free-form note** (event_type `note`, no status change) → it appears on the timeline. Try an illegal jump (Loaded before At Origin) → refused by 003's machine (`ILLEGAL_TRANSITION`). As a user **without** `update_trip_status` → refused `403`. Audit shows `trip.status_change` (milestones) + `trip.note`.
2. **US2 — Log, monitor, resolve exceptions**: on a trip, **create an exception** with a reason code → its `default_severity`/`default_responsible_party` pre-fill (editable); saved **Open**, linked to the trip, with `opened_at`, `owner` defaulted to the creator (required, reassignable), and **category derived from the reason code** (not stored). Transition **Open → Monitoring → Resolved** (closure notes required on Resolved → sets `resolved_at`); Resolved/Cancelled are **terminal** (no reopen). It fills the Trip-Detail exception panel and appears in **/exceptions** (Exception Management) filterable by **severity, customer, lane, reason, owner, age**. Pick responsible party from the **five-value** set incl. **force majeure**. A user without `create_exceptions` cannot open; without `resolve_exceptions` cannot resolve → `403`. Audit shows `exception.create` / `exception.update` / `exception.resolve` / `exception.cancel`.
3. **US3 — Server-computed SLA risk**: drive trips into each of the seven triggers and confirm `sla_status` + `sla_reasons` (server-side, never client): (a) within-window but **unassigned** → **At Risk** / `missing_assignment`; (b) **confirmation cutoff** passed (120-min default) → **At Risk** / `missed_confirmation` (reads 006 `confirmed_at`); (c) past planned **origin/destination arrival** window → **Late** / `delayed_origin_arrival`/`delayed_destination_arrival`; (d) **delayed loading/departure** via time-in-status (120-min default) → **At Risk** / `delayed_loading`/`delayed_departure`; (e) **open high-severity exception** → **At Risk** / `open_high_severity_exception`. A trip firing several triggers shows the **most-severe** state (On Track < At Risk < Late < Breached) with **all** reasons listed (e.g. Late + lists the high-sev reason too). **Breached never appears in MVP** (needs a customer threshold). On-change recompute flips risk **immediately** on the mutating action (synchronous in-tx); the worker sweep flips purely time-based risk with **no user action** (within the ~5-min cadence). Surfaces on the board, **"At risk"** view, Trip Detail, and dashboard count via polling. Terminal/cancelled trips are not evaluated.
4. **US4 — In-app alerts (the six cases)**: drive trips into each in-scope §17 case — (1) unassigned within window, (2) unconfirmed within window, (3) missed origin arrival, (4) missed departure, (5) missed destination arrival, (6) high-severity exception opened — then let the worker sweep run (the high-sev-exception alert also fires **synchronously** on exception create). Assert **exactly one** alert per (trip, case); a second sweep while the condition persists creates **no duplicate** (`ON CONFLICT DO NOTHING` on the partial-unique). **Acknowledge** an alert → it leaves the active list and the dashboard count updates, and it is **not re-spammed** while still true (uniqueness scope = `active OR acknowledged`). Clear the condition → the worker **auto-resolves** the row; a later recurrence generates a **fresh** alert. Confirm **no external channel** (email/SMS/WhatsApp/webhook/portal) is ever invoked, and the two document/billing cases (7–8) produce nothing (deferred to 008/009).
5. **US5 — Per-customer SLA rules**: as a user with `manage_commercial_data`, create a **customer SLA rule** (pickup/delivery tolerances, confirmation cutoff, at-risk warning window; optional lane/vehicle-type scope + effective dates). Assert that customer's trips are evaluated against the rule while **others fall back to `DEFAULT_SLA_POLICY`**; a customer with **no** rule is reported **SLA sign-off blocked**. With overlapping scopes, precedence resolves **lane > vehicle-type > customer-default**, tie-break latest `effective_start` (evaluator `ORDER BY … LIMIT 1`). A user **without** `manage_commercial_data` cannot edit rules → `403`. Audit shows `sla_rule.create` / `sla_rule.update`.

Leave any surface open → it refreshes via polling (board/detail ~30 s, dashboard ~60 s; no Realtime).

## Tests

```powershell
# Pure unit (no DB): the SLA evaluator + policy, the exception-lifecycle helper, vocab/Zod.
pnpm --filter "@brazil-tms/shared" test     # evaluateSlaRisk (each of the 7 triggers → state per the D1 map; worst-state-wins D2; Breached never produced; no-planned-window branch; terminal short-circuit), DEFAULT_SLA_POLICY magnitudes, canTransitionException (Open↔Monitoring; →Resolved/Cancelled terminal), EXCEPTION_* / REASON_CODE_CATEGORIES consts, exception/customer-sla-rule/trip-event/alert Zod, customer-SLA-rule precedence inputs

# Service / integration (DATABASE_URL set; run from repo root with --project web):
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
pnpm exec vitest run --project web          # createException / updateException / transitionException (guarded UPDATE 0-rows ⇒ STALE_EXCEPTION; closure_notes on Resolved; owner reassign); addTripNote; recomputeTripSla (resolve customer_sla_rules row vs DEFAULT_SLA_POLICY; atomic sla_status+sla_reasons write); customer_sla_rules precedence query (lane>vehicle-type>default, tie-break effective_start); synchronous high-sev-exception alert + ON CONFLICT idempotency; read-model extensions (loadTripDetail exceptions/alerts arrays + slaReasons + TripEventDto.exceptionId; queryExceptions filters; queryDashboardMetrics fills tripsAtRisk/activeExceptions/onTimePickupPct/onTimeArrivalPct)

# Playwright e2e (UI + authz + HTTP statuses — run against a PROD build, --workers=1):
pnpm db:seed:e2e                            # reset accounts polluted by role-change specs (001/002)
pnpm --filter "@brazil-tms/web" test:e2e    # interactive timeline milestone recording + note; exception create/monitor/resolve/cancel; Exception Management filters; SLA "At risk" view / row indicator / dashboard widgets; alert list / acknowledge; SLA-rule admin; authz (update_trip_status / create_exceptions / resolve_exceptions / manage_commercial_data 200 vs 403; view-only roles read but cannot write); HTTP statuses (401/403/404/409: ILLEGAL_TRANSITION, STALE_TRANSITION, STALE_EXCEPTION, INVALID_REASON_CODE, NOT_FOUND)

# Worker sweep test (DATABASE_URL set):
pnpm --filter "@brazil-tms/workers" test    # runSlaSweep: recomputes sla_status/sla_reasons over active trips only; generates the 6 in-scope alerts idempotently (re-run ⇒ no duplicate); auto-resolves a cleared condition; per-trip fault isolation (one bad trip is skipped, sweep continues); terminal trips skipped; per-sweep summary fields
```

Run a single web integration file, e.g.: `pnpm exec vitest run --project web apps/web/lib/trips/exceptions.test.ts` (with `DATABASE_URL` set). Test focus per STACK §3.13 + constitution: the **pure SLA evaluator** + **exception lifecycle** (Vitest, no DB), the **services** + read-model + **worker sweep** (integration with `DATABASE_URL`), and the UI + authz + HTTP-status assertions (Playwright). **HTTP-status assertions (401/403/404/409 + finding/error payloads) live in Playwright `e2e/`, not `route.test.ts`** (web Vitest only includes `lib/**`). Reset polluted accounts with `pnpm db:seed:e2e` and run e2e against a **prod build** with `--workers=1`; a stale `next dev` can hold broken HMR state and cause false 500s.

## Performance sanity (SC-005 / SC-006)

Not a perf harness — a manual spot-check at the design scale (**low-thousands of active trips**, inherited from 005/006). With the `exceptions_*` / `alerts_*` / `customer_sla_rules_*` indexes (data-model R1–R4) + the existing trip/board indexes:

- The **pure SLA evaluator** is sub-millisecond per trip; the **on-change recompute** adds negligible time inside the mutation tx (immediate UI truth — risk flips the instant the change commits, before any poll).
- **Exception Management list** (`GET /api/exceptions` with filters) and the **Control-Tower board / "At risk" view** load within **~3 s** at medium scale.
- The **~5-min worker sweep** over low-thousands of chunked (≤200/batch) trips completes well inside its cadence — verify via the per-sweep summary log (`duration_ms`, `evaluated`, `changed`, `alerts_created`, `alerts_resolved`, `errors`) in Terminal 2 (SC-006).

If the board/list exceeds the bound at medium scale, confirm the new indexes are present (`\d exceptions`, `\d alerts`, `\d customer_sla_rules`).

## Quality gate before PR (targets dev)

```powershell
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

Use the PR template (what/why/how-to-test/migration notes/risks). Note in the PR that 007 **first-enforces `update_trip_status` / `create_exceptions` / `resolve_exceptions`** (and reuses `manage_commercial_data` for SLA rules), adds **four tables + three enums + the `note` event-type member + the first scheduled worker job** (no new permission key/package/worker process), keeps `trip_events` append-only, and that **per-customer SLA rules / per-milestone planned times / the two document-&-billing §17 alert cases (008/009) / exception attachments (008)** are **gated business inputs or deferred slice dependencies — configurable defaults, not invented** (Constitution II). AI does not merge to `main`.

---

## Performance sanity (T099 · validates SC-010)

A manual spot-check, **not** a perf harness:

- **Pure SLA evaluator** (`evaluateSlaRisk`) is sub-millisecond per trip (no I/O); the on-change
  `recomputeTripSla` adds a handful of indexed point-reads + one `UPDATE` inside the mutation tx —
  negligible against the surrounding write.
- **Exception Management list** + the **board / "At risk" view** return `< ~3 s` at medium scale: the
  filters ride the `0006` indexes (`exceptions_*` on trip/status/severity/owner/reason/opened_at; the
  board's `trips_*` indexes; `customer_sla_rules_scope_idx` for policy resolution).
- **The ~5-min sweep** over low-thousands of active trips completes well inside its cadence — it scans
  only `ACTIVE_TRIP_STATUSES`, processes in ≤200-trip chunks, each trip in its own short
  `SELECT … FOR UPDATE` tx with per-trip fault isolation. Verify via the per-sweep summary log line
  (`[sla-sweep] done duration_ms=… evaluated=… changed=… alerts_created=… alerts_resolved=… errors=…`).
