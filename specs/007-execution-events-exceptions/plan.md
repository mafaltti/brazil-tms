# Implementation Plan: Execution Events, Exceptions, SLA Risk, and In-App Alerts

**Branch**: `007-execution-events-exceptions` | **Date**: 2026-05-31 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/007-execution-events-exceptions/spec.md`

## Summary

This slice turns the control tower into a **live operating board**: control-tower users record real-world **execution milestones** (At Origin → [Loading] → Loaded → In Transit → At Destination → [Unloading] → Unloaded → Completed) and **free-form events/notes** on the interactive Trip-Detail timeline; log, monitor, and resolve **exceptions** (Open ↔ Monitoring → Resolved/Cancelled, terminal) with configurable **reason codes**; see a **server-computed SLA-risk state** (On Track / At Risk / Late / Breached) with contributing reasons on the board, the **"At risk"** view, Trip Detail, and the Home Dashboard; receive **in-app alerts** for the six in-scope §17 cases; and (Ops) configure **per-customer SLA rules**. It fills slice 005's reserved timeline-interactivity, exception, SLA-indicator, and at-risk/active-exceptions/on-time dashboard placeholders.

Technical approach: 007 adds **four new tables** — `exceptions`, `reason_codes`, `customer_sla_rules` (PRD §14.1 entities) and an in-app `alerts` store (the clarified informed default for §17) — plus **three new enums** (`exception_status`, `exception_severity`, `exception_responsible_party` — the five-value set adding `force_majeure`); `alert_case`/`alert_state`/`reason_codes.category` are **CHECK-constrained text** (evolve without a `CREATE TYPE` migration), and per **D4** `trips.sla_status` stays **`text` + CHECK (no new enum)** with a new sibling **`sla_reasons text[]`**. The forward-hook `trip_events.exception_id` FK is wired, and the **single** event-vocabulary extension is `note` (per **D5**, Loading/Unloading are recorded as `status_change`, not a new event-type member). SLA authority is **server-side**: a pure `evaluateSlaRisk` evaluator in `@brazil-tms/shared` encodes the **D1** trigger→state map (window-miss ⇒ Late; everything else ⇒ At Risk; Breached unreachable in MVP) and **D2** worst-state-wins, with a labeled-configurable `DEFAULT_SLA_POLICY`; a single `recomputeTripSla` writes `sla_status`/`sla_reasons` **synchronously inside the mutation transaction** (immediate UI truth) **and** periodically via the **first-ever scheduled worker job** (a ~5-min pg-boss cron sweep, per-trip fault-isolated, `SELECT … FOR UPDATE`, idempotent alert generation/auto-resolution). Exception, note, and SLA-rule services in `@brazil-tms/db` **mirror 003's `transitionTripStatus`/`cancelTrip` transaction pattern**; milestone recording **reuses `transitionTripStatus`** (the status machine is **not** redefined). Authorization adds **no new permission key**: 007 **first-enforces** `update_trip_status`, `create_exceptions`, `resolve_exceptions` and **reuses** `manage_commercial_data` for SLA-rule admin (reads + alert acknowledgement stay on `view_all_trips`) — mirroring 004/`import_trips`, 005/`view_all_trips`, 006/`assign_resources`. Per the spec's three clarification sessions, gated business inputs are **documented configurable defaults, never invented** (Constitution II): per-customer SLA rules → company defaults + per-customer SLA sign-off blocked (§29 Input #2); per-milestone planned times → time-in-status default (120 min); §17 alert cases 7–8 → deferred to 008/009; exception/event attachments → deferred to 008.

## Technical Context

**Language/Version**: TypeScript 5.6 (strict); Node.js 20 LTS; pnpm 10 monorepo.

**Primary Dependencies** (existing — **no new runtime deps**): Next.js 15 (App Router) + React 19; Drizzle ORM over `postgres` (server-only); Zod (SLA-rule / exception / milestone-note / alert-ack input validation, shared by web + worker); Luxon (`America/Sao_Paulo`; SLA window / confirmation-cutoff / time-in-status arithmetic in UTC); **TanStack Query** (polling + mutations) + **TanStack Table**; `next-intl` (pt-BR); shadcn/ui + Radix + lucide-react; **`pg-boss`** (the existing Postgres-backed queue from 004 — 007 adds its **first scheduled job**, no new queue/library).

**Storage**: self-hosted Supabase Postgres. **Four new tables** (`exceptions`, `reason_codes`, `customer_sla_rules`, `alerts`); **three new pgEnums** (`exception_status`, `exception_severity`, `exception_responsible_party`); `alert_case`/`alert_state`/`reason_codes.category` are **`text` + CHECK** (not enums). **`trips` ALTER**: add `sla_reasons text[]` (the schema's first array column) + `trips_sla_status_ck` CHECK; `sla_status` keeps its 003 `text` type — **no new enum** (D4). **`trip_events` ALTER**: wire the existing `exception_id` column's FK → `exceptions`, and add the single `trip_event_type` member `note` (D5 — Loading/Unloading stay `status_change`). One migration `0006_*.sql` (next after `0005_conscious_kat_farrell.sql`); indexes per [data-model.md](./data-model.md) incl. the `alerts_trip_case_open_uq` partial-unique on `(trip_id, alert_case) WHERE state IN ('active','acknowledged')`. `trip_events` **keeps its append-only REVOKE**; the four new tables **mutate** (status/owner/closure, rule edits, acknowledge/resolve) like `trip_assignments` → no REVOKE. PostgREST/gateway never exposed; service-role key server-only (also in the worker).

**Testing**: Vitest is the primary gate. **Pure unit** (`packages/shared`): `evaluateSlaRisk` over the D1 map × each of the seven reasons × worst-state-wins (D2) × no-planned-window branch × time-in-status × Breached-never-in-MVP × `DEFAULT_SLA_POLICY`; `canTransitionException` over every legal/illegal edge (incl. terminal no-reopen); the new Zod schemas; the new `AuditAction`s (+ `ALL_AUDIT_ACTIONS` lockstep); `SLA_STATUSES`/`SLA_REASONS`/`EXCEPTION_*` consts. **Service/integration** (`apps/web` lib, dev DB, `describe.skipIf(!DATABASE_URL)`, **static imports** per MEMORY): `createException` (reason-code defaults pre-fill, `INVALID_REASON_CODE`, owner-defaults-to-creator), `updateException`, `transitionException` (`STALE_EXCEPTION`, `ILLEGAL_EXCEPTION_TRANSITION`, closure-notes-on-Resolved, terminal-no-reopen); `recomputeTripSla` (each trigger → correct state + reasons, worst-state, Breached-never); `addTripNote` (`note` event, no status change); `customer_sla_rules` precedence resolution (lane > vehicle-type > default, tie-break latest `effective_start`; absence ⇒ defaults + sign-off blocked); milestone via `transitionTripStatus` drives `recomputeTripSla`; read-model fills (4 dashboard metrics, `slaReasons`/`exceptionId`/exception+alert arrays). **Worker** (`workers/jobs/sla-sweep`): per-trip fault isolation (one bad trip doesn't abort the sweep), idempotent alert generation (`ON CONFLICT DO NOTHING`) + auto-resolve, chunking. **Playwright** (`e2e/`): interactive timeline (record milestone + note), exception lifecycle UI, Exception Management filters (severity/customer/lane/reason/owner/age), SLA indicators + "At risk" view + dashboard widgets, alerts surface + acknowledge, SLA-rule admin; **authz first-enforcement** — `update_trip_status`/`create_exceptions`/`resolve_exceptions`/`manage_commercial_data` holder `200` vs non-holder `403`, view-only roles read + acknowledge via `view_all_trips`. Route HTTP-status (401/403/400/404/409) + payloads asserted in `e2e/` (no `route.test.ts`, per MEMORY). `messages.test.ts` i18n guard (nested + flat audit keys, **no dotted keys**). MEMORY also applies: web vitest via `pnpm exec vitest run --project web <file>` with `DATABASE_URL`; the Drizzle array-expansion gotcha when reading `sla_reasons`; alert idempotency via `ON CONFLICT` (analogous to the partial-unique supersede ordering).

**Target Platform**: Linux server via Docker Compose (Supabase, app, **worker**, Caddy). Desktop-first, evergreen browsers (PRD §16). **Worker ACTIVE for the first time as a scheduler** — the existing `@brazil-tms/workers` process gains a single ~5-min `boss.schedule` SLA sweep (cadence configurable via `SLA_SWEEP_CRON`), in addition to its existing import jobs.

**Project Type**: Web application — existing monorepo (`apps/web` + `packages/{shared,db}` + `workers/`). **No new package, no new worker process** — the worker built by 004 gains its first scheduled job.

**Performance Goals**: the pure SLA evaluator is sub-millisecond per trip; the synchronous on-change `recomputeTripSla` adds negligible time inside the mutation transaction; Exception Management list and the board load within **~3 s** at medium scale (inheriting 005's targets), backed by the new `exceptions_*`/`alerts_*`/`customer_sla_rules_*` indexes; the **~5-min worker sweep** over **low-thousands** of active trips, **chunked (≤200/batch)** with per-trip `FOR UPDATE`, completes well within cadence (proven by the per-sweep summary log). Freshness = **polling** reusing 005's cadences (board/detail `CONTROL_TOWER_POLL_MS = 30 s`, dashboard `60 s`); no Realtime.

**Constraints**: BFF-only authorization; **SLA authority server-side, never UI** (a pure evaluator the BFF + worker call — Constitution III / STACK §6); service-role key server-only (app + worker); gateway/PostgREST never public; **NO** Realtime / Edge Functions / Redis-BullMQ / microservices / route optimizer; freshness via **polling**; **reuses 002/003/005/006** without redefining the status machine, `transitionTripStatus`, the append-only `trip_events` log, master data, the 006 assignment/confirmed-at state, or the 005 read models — milestones drive existing transitions, exception/note/SLA-rule changes are **audited** (append-only `audit_logs`); `trip_events` stays append-only; the four new tables are **retained, never hard-deleted** (a recurrence is a new exception; alerts auto-resolve, never delete); reason codes + SLA rules are **config-driven** (no per-customer code); UI pt-BR; timestamps UTC (displayed `America/Sao_Paulo`).

**Scale/Scope**: **4** new tables; **3** new enums (+ `alert_case`/`alert_state`/`reason_codes.category` as CHECK text; **`sla_status` no new enum** — D4); **~16** new indexes (incl. 1 partial-unique); **1** `trips` ALTER (`sla_reasons text[]` + CHECK) + **1** `trip_events` ALTER (FK + `note` member); **0** new permission keys — **first-enforce** `update_trip_status`/`create_exceptions`/`resolve_exceptions`, **reuse** `manage_commercial_data` (reads stay `view_all_trips`); **~12 BFF endpoints** (milestone · note · exception create/update/transition · Exception Management list · reason-code list · SLA-rule list/create/update · alert list/acknowledge · 3 extended reads); **2** new pure `shared` domain modules (`sla-risk`, `exceptions`) + `sla/jobs` contract + **~4** Zod files + the audit-action extension; **~5** new `db` services (`createException`/`updateException`/`transitionException`, `recomputeTripSla`, `addTripNote`) + read-model extensions + the Exception/alert/SLA-rule reads; **1** new worker job (`sla-sweep` — first scheduled); UI fills (interactive timeline, exception panel + Exception Management screen, SLA indicator + "At risk" view, alerts surface, customer-SLA-rule admin, 4 dashboard widgets). **Open items are configurable defaults / deferred slice inputs, not blockers and not invented** (Constitution II): per-customer SLA rules (§29 Input #2 — defaults + per-customer SLA sign-off blocked), per-milestone planned times (time-in-status 120-min default), §17 alert cases 7–8 (008/009), exception/event attachments (008).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Confirmed against `.specify/memory/constitution.md` (v1.0.0):

- [x] **Simplicity (I)**: The **four** new tables are each a distinct **in-scope** entity the slice owns — `exceptions`, `reason_codes`, `customer_sla_rules` are PRD §14.1 entities (SPEC-SLICING 007) and `alerts` is the **clarified informed-default** in-app store for §17 (not speculative; resolved in Clarifications, not invented). **Three** enums are created only for **fixed domain sets referenced by logic** (`exception_status`/`severity`/`responsible_party`); evolving sets (`alert_case` with 2 deferred cases, `alert_state`, `reason_codes.category`) and `sla_status` (D4) are **CHECK text** to avoid `CREATE TYPE` churn — the established `enums.ts`-vs-`cancellation_options` rule. **No** new permission key (reuse + first-enforce), **no** new package, **no** new worker process (the 004 worker gains one scheduled job), **no** `sla_status` enum, **no** new `trip_event_type` member beyond `note`. The SLA evaluator and exception lifecycle are **two concrete pure modules** in `shared` (not a generic "engine"); services **reuse** the `transitionTripStatus`/`writeAudit`/`loadTripDetail` building blocks (no abstraction below the ≥3 rule).
- [x] **Scope (II)**: Strictly EVT/EXC/SLA-001..004 + CUST-005 + the §14.1 entities + the §17 alert store + the 005-shell fills (SPEC-SLICING 007). GPS/geofence (EVT-006/007, §20.2), external notifications (SLA-006/007, §17 Later), SLA performance reporting (SLA-005), escalation (EXC-007), documents (008), billing (009) are **out of scope**. Gated inputs (per-customer SLA rules §29 #2; per-milestone planned times; §17 cases 7–8; attachments) are **labeled configurable defaults / deferred**, **not** marked complete and **not** invented — final customer SLA sign-off is explicitly **blocked** until rules are supplied (FR-022).
- [x] **System-of-record (III)**: Durable state in Postgres. **SLA classification is server-side** (the pure evaluator the BFF + worker call; the UI never computes — FR-014). Milestones **drive** the explicit 003 status machine via `transitionTripStatus` (not redefined); `trip_events` stays **append-only** (keeps its REVOKE). Exceptions/alerts/rules **mutate** but are **never hard-deleted** (a recurrence is a new exception; alerts auto-resolve to a retained `resolved` row); the immutable `original_plan` is untouched; exception/note/SLA-rule changes are **audited** (append-only `audit_logs`). Status remains an enumerated machine with declared transitions (trip + exception).
- [x] **Authz & secrets (IV)**: Every write goes through the **BFF** + `requirePermission` — milestone/note `update_trip_status`, exception create `create_exceptions`, exception update/transition `resolve_exceptions`, SLA rules `manage_commercial_data` (all **first enforcement** except `manage_commercial_data`); reads + alert acknowledgement on `view_all_trips`. RLS deferred; service-role key server-only (app **and** worker); gateway never exposed. Exception/note/SLA-rule actions audited (`exception.create`/`update`/`resolve`/`cancel`, `trip.note`, `sla_rule.create`/`update`); milestones reuse `trip.status_change`.
- [x] **Config over code (V)**: **Reason codes** are config rows (mirroring `cancellation_options`), seeded as **labeled scaffolding** pending business sign-off; **SLA rules** are per-customer `customer_sla_rules` config with a `DEFAULT_SLA_POLICY` fallback — **no per-customer branches**. Severity scale, the trigger→state map, and threshold magnitudes are typed config/constants, overridable per customer. Customer variation surfaces only as config + i18n labels.
- [x] **Tech constraints**: Freshness is **polling** (TanStack Query `refetchInterval`); background recalc/alert generation runs on the **existing pg-boss queue + single Node worker** via its built-in cron — **no Realtime, no Edge Functions, no Redis/BullMQ, no microservices, no route optimizer**. One app, one worker.
- [x] **Workflow**: Short-lived `007-execution-events-exceptions` branch → PR to **`dev`**; CI gates (lint/typecheck/build/tests) must pass; PR template used; AI does not merge to `main`.

**Result: PASS.** The four new tables are the justified, in-scope §14.1 entities + the clarified §17 alert store; the worker is **reused** (first scheduled job, not a new process); every other lever (permission key, package, `sla_status` enum, event-type member) is reused or avoided. The first scheduled worker job is the **constitutionally pre-declared background mechanism** (STACK Technology Constraints) meeting its first in-scope need (time-based SLA risk must surface with no user action — FR-019/SC-006), not speculative complexity. **Complexity Tracking is therefore empty.**

### Post-Design re-check (after Phase 1)

Re-evaluated after producing `research.md`, `data-model.md`, `contracts/`, and `quickstart.md`: **still PASS, no new violations.** The data model adds exactly the four in-scope tables + three enums (CHECK text for the evolving sets), keeps `sla_status` as `text` (D4), and adds no permission key; contracts keep SLA/alert authority server-side (the evaluator + worker), with alert acknowledgement on `view_all_trips` (view triage, not a write key — SC-009 lists only the four write keys); the evaluator and exception lifecycle stayed two pure `shared` modules; the worker remained one scheduled job on the existing process. Three migration hand-verifications are noted (the cross-feature `trip_events.exception_id` FK + `trips_sla_status_ck` on pre-existing columns; the first `text[]` column; `ALTER TYPE … ADD VALUE 'note'` ordering vs. its first use). Complexity Tracking remains empty.

## Project Structure

### Documentation (this feature)

```text
specs/007-execution-events-exceptions/
├── plan.md                       # This file (/speckit-plan output)
├── research.md                   # Phase 0 — design decisions (R0–R16)
├── data-model.md                 # Phase 1 — 4 tables + 3 enums, trips/trip_events ALTER, SLA evaluator + exception lifecycle, services, read-model fills, migration 0006
├── quickstart.md                 # Phase 1 — setup/run (incl. the worker), migration + seed, US-by-US verification, tests
├── contracts/
│   ├── bff-endpoints.md          # milestone · note · exception create/update/transition · exceptions list · reason-codes · sla-rules · alerts · extended reads
│   └── permission-matrix.md      # no new key — first enforcement of update_trip_status/create_exceptions/resolve_exceptions; reuse manage_commercial_data
├── spec.md                       # Feature spec (/speckit-specify + 3 /speckit-clarify sessions)
├── checklists/requirements.md    # Spec quality checklist (16/16)
└── tasks.md                      # Phase 2 — /speckit-tasks (NOT created by /speckit-plan)
```

### Source Code (repository root) — extends the existing monorepo

```text
packages/shared/src/
├── domain/sla-risk.ts                  # NEW: evaluateSlaRisk + SLA_STATUSES/SLA_REASONS + SlaContext/SlaPolicy + DEFAULT_SLA_POLICY (D1/D2)
├── domain/exceptions.ts                # NEW: EXCEPTION_STATUSES/SEVERITIES/RESPONSIBLE_PARTIES + REASON_CODE_CATEGORIES + canTransitionException
├── sla/jobs.ts                         # NEW: SLA_JOBS job-name/payload contract (sibling of import/jobs.ts; pure, shared by worker)
├── audit/actions.ts                    # EXTEND: + exception.create/update/resolve/cancel · trip.note · sla_rule.create/update (+ ALL_AUDIT_ACTIONS)
├── schemas/{trip-event,exception,customer-sla-rule,alert}.ts  # NEW: note/milestone · exception create/update/transition · SLA-rule · alert-ack schemas
├── schemas/trip-board.ts               # EXTEND: + slaStatus / atRisk filter param (the "At risk" view)
└── index.ts                            # EXTEND: export the new domain/schema/jobs modules

packages/db/
├── schema/{reason-codes,exceptions,customer-sla-rules,alerts}.ts  # NEW: the four tables (+ CHECKs, indexes, alerts partial-unique)
├── schema/enums.ts                     # EXTEND: + exception_status/severity/responsible_party pgEnums; + 'note' in trip_event_type
├── schema/trips.ts                     # EXTEND: + sla_reasons text[] + trips_sla_status_ck CHECK (sla_status type unchanged — D4)
├── schema/trip-events.ts               # EXTEND: + exception_id .references(() => exceptions.id)
├── schema/index.ts                     # EXTEND: export reason-codes/exceptions/customer-sla-rules/alerts
├── migrations/0006_*.sql               # NEW: CREATE TYPE×3 + ALTER TYPE 'note' + CREATE TABLE×4 + ALTER trips + ALTER trip_events (hand-verify: FK, CHECK, text[], ADD VALUE ordering)
├── seed/{reason-codes,sla-rules}.ts    # NEW: labeled-scaffolding reason codes + a sample customer SLA rule (+ db:seed:reason-codes / db:seed:sla-rules scripts)
└── src/
    ├── trips/exceptions.ts             # NEW: createException / updateException / transitionException (mirror transitionTripStatus tx pattern)
    ├── trips/sla.ts                    # NEW: recomputeTripSla (single on-change recompute; resolves customer rule or DEFAULT_SLA_POLICY)
    ├── trips/trip-events.ts            # NEW: addTripNote ('note' event, no status change)
    ├── trips/trips-read.ts             # EXTEND: slaStatus/slaReasons + atRisk filter; fill tripsAtRisk/activeExceptions/onTimePickupPct/onTimeArrivalPct; queryExceptions/queryReasonCodes/listAlerts/queryCustomerSlaRules; reason-code + owner filter options
    ├── trips/trip-dto.ts               # EXTEND: + slaReasons on TripSummary; + exceptionId on TripEventDto; + exceptions[]/alerts[] on TripDetail (single loadTripDetail)
    └── index.ts                        # EXTEND: export the new services + reads

workers/
├── jobs/sla-sweep/index.ts             # NEW: runSlaSweep (chunked, per-trip fault isolation + FOR UPDATE, idempotent alert gen/auto-resolve, summary log) + registerSlaSweep(boss)
├── jobs/index.ts                       # EXTEND: register the sla-sweep handler
├── lib/queue.ts                        # EXTEND: merge SLA_JOBS into JOB/JobPayloads + setupQueues; boss.schedule(sla.sweep, cron)
└── .env                                # EXTEND: + SLA_SWEEP_CRON (also added to infra/supabase/docker-compose.yml worker env)

apps/web/
├── lib/trips/
│   ├── client.ts                       # EXTEND: useRecordMilestone/useAddTripNote/useCreateException/useUpdateException/useTransitionException/useAcknowledgeAlert + exception/alert query hooks (reuse poll constants; invalidate ["trips"]/["exceptions"]/["alerts"])
│   ├── exceptions.ts · sla-rules.ts · alerts.ts  # NEW: server-only re-exports of the @brazil-tms/db services/reads
│   └── views.ts                        # EXTEND: + "at_risk" view preset (slot reserved by 005)
├── lib/nav.ts                          # EXTEND: + Exception Management (view_all_trips) · SLA Rules admin (manage_commercial_data)
├── app/api/trips/[id]/status/route.ts          # NEW: POST milestone (update_trip_status) → transitionTripStatus + recomputeTripSla
├── app/api/trips/[id]/events/route.ts          # NEW: POST free-form note (update_trip_status)
├── app/api/trips/[id]/exceptions/route.ts      # NEW: POST create exception (create_exceptions)
├── app/api/exceptions/[id]/route.ts            # NEW: PATCH update (resolve_exceptions)
├── app/api/exceptions/[id]/transition/route.ts # NEW: POST transition (resolve_exceptions)
├── app/api/exceptions/route.ts                 # NEW: GET Exception Management list (view_all_trips)
├── app/api/reason-codes/route.ts               # NEW: GET active reason codes (view_all_trips)
├── app/api/customer-sla-rules/route.ts         # NEW: GET (view_all_trips) / POST (manage_commercial_data)
├── app/api/customer-sla-rules/[id]/route.ts    # NEW: PATCH (manage_commercial_data)
├── app/api/alerts/route.ts                     # NEW: GET active/acknowledged + counts (view_all_trips)
├── app/api/alerts/[id]/acknowledge/route.ts    # NEW: POST acknowledge (view_all_trips)
├── app/api/trips/route.ts · trips/[id]/route.ts · dashboard/summary/route.ts  # EXTEND: SLA status+reasons, exception/alert arrays, 4 dashboard fills
├── app/(shell)/exceptions/page.tsx             # NEW: Exception Management screen (§15.8)
├── app/(shell)/sla-rules/page.tsx              # NEW: per-customer SLA-rule admin (manage_commercial_data)
├── components/trips/trip-detail/
│   ├── timeline.tsx                    # EXTEND: interactive — milestone recording + note/attachment-deferred entry (upgrades 005's read-only timeline)
│   ├── exception-panel.tsx             # NEW: replaces ExceptionPlaceholder (list + create/transition)
│   ├── sla-indicator.tsx               # NEW: replaces the SLA placeholder (status + reasons)
│   └── placeholders.tsx                # EXTEND: remove the filled placeholders (others untouched)
├── components/exceptions/*             # NEW: Exception Management table + filters (severity/customer/lane/reason/owner/age)
├── components/alerts/*                 # NEW: in-app alert surface (list + acknowledge) on board/dashboard
├── components/control-tower-table.tsx  # EXTEND: + SLA-risk row indicator/column + "At risk" view
├── components/dashboard/widgets.tsx    # (auto-renders the 4 filled metrics once the read model returns numbers)
└── messages/pt-BR.json                 # EXTEND: Exceptions / Alerts / SLA namespaces + audit actions (nested + flat, no dotted keys)
```

**Structure Decision**: Web application on the existing monorepo. The new domain logic splits the established way: **pure, DB-free** rules (the SLA evaluator + policy, the exception lifecycle + vocabulary, the job contract, Zod) in `@brazil-tms/shared`; **stateful** services + read-model extensions in `@brazil-tms/db` (`trips/exceptions.ts`, `trips/sla.ts`, `trips/trip-events.ts` beside 003's `trip-transitions.ts` and 005/006's `trips-read.ts`), re-exported server-only via `apps/web/lib/trips/`; the **first scheduled job** in the existing `workers/` process. UI extends 005's `(shell)` screens/registries (interactive timeline, exception/SLA fills, "At risk" view, dashboard widgets) and adds the Exception Management + SLA-rule admin screens. No new package, worker process, or permission key.

## Complexity Tracking

> No Constitution Check violations. The four new tables are the in-scope PRD §14.1 entities the slice owns (`exceptions`, `reason_codes`, `customer_sla_rules`) plus the clarified §17 in-app `alerts` store — justified under Principle I/III, not speculative. Three enums for fixed domain sets; CHECK text for the evolving sets and `sla_status` (D4 — no new enum). No new permission key (first-enforce three + reuse `manage_commercial_data`), no new package, **no new worker process** (the 004 worker gains its first scheduled job — the constitutionally pre-declared background mechanism meeting its first in-scope need), no abstraction below the ≥3 threshold (the SLA evaluator and exception lifecycle are two concrete pure modules; services reuse 003's transaction building blocks). This section is intentionally empty.
