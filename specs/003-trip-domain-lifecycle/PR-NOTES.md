# PR: Trip Domain, Status Machine, and Audit Semantics (003)

**Base**: `dev` ← **Head**: `003-trip-domain-lifecycle` · AI must not merge to `main`.

## What changed

The shared, reusable **trip domain** that slices 004–009 build on. Foundational + headless:

- **DB (`packages/db`)** — 3 new `public` tables: `trips` (durable record; immutable `original_plan`
  jsonb + live `planned_*` columns + cancellation fields + `disputed_from_status`), `trip_events`
  (append-only milestone/status-change log), `cancellation_options` (config-driven `reason` /
  `billing_impact` value sets via a `kind` discriminator). 4 new enums: `trip_status` (18),
  `trip_event_type`, `trip_event_source`, `cancellation_responsible_party`. One migration
  (`0002_uneven_dreadnoughts.sql`) + a **manual** `REVOKE UPDATE, DELETE ON trip_events FROM PUBLIC`
  (drizzle-kit won't emit it; mirrors 001 `audit_logs`).
- **Shared (`packages/shared`)** — `domain/trip-status.ts`: the single `TRIP_STATUSES`, `TRANSITIONS`
  table, `canTransition()`, `billingStatus()` projection, `TRIP_CRITICAL_FIELDS` (the source of truth
  slices 004–009 import, FR-023). `+ manage_trips` permission (Admin, Ops Manager). `+` four
  `AuditAction`s (`trip.create|plan_update|status_change|cancel`). `schemas/trip.ts` Zod (pt-BR).
- **App (`apps/web`)** — service layer in `lib/trips/`: `createTrip`, `updateTripPlan`,
  `transitionTripStatus`, `cancelTrip` (each one atomic transaction: row change + `trip_event` for
  transitions + `audit_logs` row), plus `trip-dto.ts` (shared `TripDetail`/`TripSummary` mapping +
  `loadTripDetail`). Read-only inspector: `GET /api/trips`, `GET /api/trips/:id` (behind
  `requireAuth` + `requirePermission('manage_trips')`). No mutation endpoints (owned by 004–007).
- **Seed** — `db:seed:trip-domain`: seeds `billing_impact` scaffolding; leaves `reason` codes EMPTY.

## Why

Establish the durable system-of-record + the single status machine once, so import (004), control
tower (005), dispatch (006), execution/SLA (007), billing (008), and reporting (009) reuse it rather
than redefine it (FR-023). Planned-vs-executed separation, explicit enumerated transitions, and
append-only audit/events are Constitution III requirements. Reuses 001 auth/audit + 002 master-data
FKs unchanged; no new package, service, worker, or route optimizer.

## How to test

```powershell
docker compose -f infra/supabase/docker-compose.yml up -d
pnpm --filter @brazil-tms/db db:migrate          # applies 0002 incl. the trip_events REVOKE
pnpm --filter @brazil-tms/db db:seed:trip-domain # billing_impact scaffolding; reason empty
pnpm lint; pnpm typecheck; pnpm build
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'; pnpm test  # 333 pass
# e2e against a production build (next dev cold-compile times out heavy UI pages locally):
pnpm --filter @brazil-tms/web build; pnpm --filter @brazil-tms/web start  # then, in another shell:
$env:PLAYWRIGHT_BASE_URL='http://localhost:3000'; pnpm --filter @brazil-tms/web exec playwright test
```

Success criteria covered by the Vitest suite (the US1–US5 walkthrough):
- **SC-001** denied/failed mutation = no state change → illegal/stale transition tests (status unchanged).
- **SC-002** original plan immutable/retrievable → `original_plan` stored at create; unchanged across plan updates.
- **SC-003** every critical change audited, atomically → exactly-one-audit-per-action + append-only tests.
- **SC-004** cancellation complete + config-driven + fail-when-unconfigured → cancellation tests.
- **SC-005** one status, billing as projection → billing-phase + domain projection tests.
- **SC-006** planned vs executed distinguishable → `origin_arrived` event vs planned windows test.

## Migration notes

- New `public` tables/enums only; `auth.*` untouched; `schemaFilter: ["public"]`.
- **Manual step baked into `0002`**: `REVOKE UPDATE, DELETE ON "trip_events" FROM PUBLIC;` — keep it
  on any regeneration. Append-only is enforced for non-superuser roles (verified in
  `trip-audit-immutability.test.ts` via `SET ROLE`).

## Risks / Blocked

- **Business-blocked (Constitution II — labeled scaffolding, NOT final sign-off)**: cancellation
  **reason codes** (seeded EMPTY → production cancellation fails with `CANCELLATION_NOT_CONFIGURED`
  until business supplies them) and **billing-impact values** (seeded with §19.5 examples as labeled
  scaffolding). Final domain sign-off remains BLOCKED on these two inputs.
- Local full-suite Playwright against `next dev` is flaky (on-demand compilation + unbounded workers);
  run e2e against a production build / `workers: 1` (as CI does). Feature e2e (`trips-inspector`) green.

## Principles applied

KISS/DRY/YAGNI: one transition table (data, not a trigger), `billingStatus` a pure projection (no
stored column), `cancellation_options` one table with a `kind` discriminator (not two), one shared
`trip-dto` mapping for four producers, optimistic concurrency (no locks/version column). No new
package/service. Authz at the BFF; service-role key server-only; gateway not exposed.
