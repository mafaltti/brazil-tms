# Implementation Plan: Trip Domain, Status Machine, and Audit Semantics

**Branch**: `003-trip-domain-lifecycle` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-trip-domain-lifecycle/spec.md`

## Summary

Establish the **shared trip domain** the rest of the MVP builds on: a durable `trips` table with the
immutable original customer plan kept separate from executed values, a single explicitly-enumerated
**trip status machine** (18 statuses, declared legal transitions, billing-phase states as its tail), a
**trip-events** foundation that records actual milestones and every status change, **cancellation**
semantics (five required inputs; reason/billing-impact config-driven), and an **audit expansion** that
reuses feature 001's append-only `audit_logs`. This slice is intentionally **foundational and mostly
headless**: it ships the domain/service layer plus read-only inspector endpoints to verify the model, and
the operational mutation surfaces (import, control tower, dispatch, execution timeline, billing) are owned
by slices 004–009, which **reuse** this domain rather than redefine it (FR-023).

Technical approach: one Postgres `pgEnum` per enumerated set; the **single transition table** lives in
`@brazil-tms/shared` as the one source of truth all later slices import; status transitions, plan updates,
and cancellations each run as **one DB transaction** that writes the row change + a `trip_event` (for
transitions) + an `audit_logs` row, so no critical change is ever unlogged. Concurrency on transitions uses
a **status-guarded conditional update** (`WHERE current_status = expectedFrom`) → `409` on stale write.
Reuse, unchanged, 001's `requireAuth`/`requirePermission`, `writeAudit`, `handleRouteError`/`Conflict`, the
Drizzle client, and 002's master-data FKs. No new package, no worker.

## Technical Context

**Language/Version**: TypeScript 5.6 (strict); Node.js 20 LTS; pnpm 10 monorepo.

**Primary Dependencies** (already in the repo from 001/002): Next.js 15 (App Router) + React 19; Drizzle ORM
(`drizzle-orm ≥0.36`, `drizzle-kit ≥0.28`) over `postgres` (3.4) — direct server-only connection; Zod 3.23;
`@supabase/ssr` + `@supabase/supabase-js` (auth/session only); Luxon 3 (`America/Sao_Paulo`, UTC storage);
`next-intl` 4 (pt-BR); TanStack Query 5 + Table 8 (consumed by later UI slices, not this one).

**Storage**: self-hosted Supabase Postgres. **New** `public` tables: `trips`, `trip_events`,
`cancellation_options`. **New** enums: `trip_status` (18), `trip_event_type`, `trip_event_source`,
`cancellation_responsible_party`. Writes to the existing `public.audit_logs` (reused, append-only). FKs to
existing `customers`, `locations`, `lanes` (002), and `users` (001). `trip_events` is hardened append-only
(`REVOKE UPDATE, DELETE`) like `audit_logs`. Access via Drizzle (server-only); PostgREST/gateway never exposed.

**Testing**: Vitest is the primary gate for this headless slice — transition-table legality (pure unit),
`billingStatus` projection (pure unit), critical-field set (pure unit), and **service-layer integration**
against the dev DB: create→transition path, illegal-transition rejection (status unchanged), atomic
status+event+audit write, optimistic-conflict `409`, plan-update preserves original + audits, cancellation
five-input validation + missing-config failure, append-only enforcement. Playwright: a thin API-level check
that the read-only inspector endpoints enforce `401/403` and return trip + events + audit.

**Target Platform**: Linux server via Docker Compose (Supabase, app, Caddy); evergreen browsers (inspector
only). Worker unused.

**Project Type**: Web application — existing monorepo (`apps/web` + `packages/{shared,db}`); **no new package**.

**Performance Goals**: no hard latency target. Status transitions, plan updates, and cancellations are
synchronous single-transaction BFF/service calls (sub-second). Read-only inspector lists return flat arrays
with TanStack Query polling in later UI slices; trip volumes are modest for MVP (~1000s/month).

**Constraints**: BFF-only data access; service-role key server-only; gateway/PostgREST never public; **NO**
Realtime / Edge Functions / external broker / microservices / route optimizer; freshness via polling; status
is an explicit enumerated machine (never free-form); original plan immutable; audit + events append-only
(soft-delete/archival only, no hard delete); UI pt-BR; timestamps UTC (displayed `America/Sao_Paulo`); money
as integer centavos, BRL.

**Scale/Scope**: 3 new tables; 4 new enums; **1** new permission key (`manage_trips`); 4 new audit actions;
the 18-state transition table; ~2 read-only inspector endpoints + a reusable domain/service API (create,
transition, update-plan, cancel) consumed by slices 004–009. Two business inputs remain **blocked**
(cancellation reason codes; billing-impact values) — scaffolded config-driven, not invented.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Confirmed against `.specify/memory/constitution.md` (v1.0.0):

- [x] **Simplicity (I)**: One transition table (data, not a trigger/engine); `billingStatus` is a pure
  projection function (no stored column); concurrency is optimistic (no locks/event-sourcing); no new
  package/service; no abstraction introduced below the ≥3 threshold (e.g., `cancellation_options` is **one**
  table with a `kind` discriminator, not two near-identical tables, and not a speculative generic engine).
- [x] **Scope (II)**: Within slice 003 per `docs/SPEC-SLICING.md`. Out-of-scope surfaces (import UI 004,
  control tower 005, dispatch 006, execution timeline/SLA 007, documents/billing-export 008, reports 009)
  are not built. The two PRD-gated inputs (reason codes, billing-impact values) are **labeled** config-driven
  scaffolding and **not** marked complete — final sign-off stays BLOCKED.
- [x] **System-of-record (III)**: Postgres owns durable state; original plan stored separately
  (`original_plan` immutable snapshot) and immutable after import; status is an explicit `pgEnum` with a
  declared legal-transition table; `audit_logs` and `trip_events` are append-only (DB `REVOKE`), soft-delete only.
- [x] **Authz & secrets (IV)**: The only client-exposed surface in this slice — the read-only trip inspector —
  is gated by `requireAuth` + `requirePermission(ctx, 'manage_trips')`. The mutating domain operations
  (create/transition/plan-update/cancel) are **server-only service functions with no public endpoint in 003**;
  their HTTP authorization is enforced by the calling route handlers introduced in slices 004–007 (which pass
  an authorized actor — see contracts/trip-domain-api.md), so no unauthorized mutation path is exposed.
  Service-role key server-only; gateway not exposed; create, status-change, plan-update, and cancel are audited.
- [x] **Config over code (V)**: Cancellation reason codes and billing-impact values are data-driven
  (`cancellation_options`), not hardcoded; "missing configuration → fail" is honored. No per-customer code.
- [x] **Tech constraints**: self-hosted Supabase (Postgres/Auth/Storage); polling-only; no worker needed
  this slice. NO Realtime, NO Edge Functions, NO Redis/BullMQ, NO microservices, NO route optimizer.
- [x] **Workflow**: feature branch `003-trip-domain-lifecycle` → PR to `dev`; CI gates (lint/typecheck/
  build/tests) green; PR template used; AI does not merge to `main`.

**Result: PASS.** No violations; **Complexity Tracking is therefore empty.**

## Project Structure

### Documentation (this feature)

```text
specs/003-trip-domain-lifecycle/
├── plan.md                       # This file (/speckit-plan output)
├── research.md                   # Phase 0 — design decisions (R0–R12)
├── data-model.md                 # Phase 1 — tables, enums, transition table, lifecycle, audit, validation
├── quickstart.md                 # Phase 1 — migrate, exercise, test, quality gate
├── contracts/
│   ├── bff-endpoints.md          # Read-only inspector endpoints (this slice's BFF surface)
│   ├── trip-domain-api.md        # Reuse contract: status enum, transition table, projection, service API
│   └── permission-matrix.md      # New `manage_trips` key + matrix + invariants
├── spec.md                       # Feature spec (/speckit-specify + /speckit-clarify)
├── checklists/requirements.md    # Spec quality checklist
└── tasks.md                      # Phase 2 — /speckit-tasks (NOT created by /speckit-plan)
```

### Source Code (repository root) — extends the existing monorepo

```text
packages/db/
├── schema/
│   ├── enums.ts                  # EXTEND: + trip_status, trip_event_type, trip_event_source,
│   │                             #         cancellation_responsible_party
│   ├── trips.ts                  # NEW: trips table (plan snapshot + planned_* + current_status + cancel fields)
│   ├── trip-events.ts            # NEW: trip_events table (append-only)
│   ├── cancellation-options.ts   # NEW: cancellation_options table (kind ∈ reason | billing_impact)
│   └── index.ts                  # EXTEND: export the new schema files
├── migrations/                   # drizzle-kit generate output + a manual REVOKE on trip_events (like audit_logs)
└── seed/
    └── trip-domain-sample.ts     # NEW (optional): seed cancellation_options + sample trips for e2e/dev

packages/shared/src/
├── domain/
│   └── trip-status.ts            # NEW: TRIP_STATUSES, TRANSITIONS (single source of truth), canTransition(),
│                                 #      billingStatus() projection, TRIP_CRITICAL_FIELDS default set
├── schemas/
│   └── trip.ts                   # NEW: Zod — createTrip, updateTripPlan, transitionTrip, cancelTrip
├── audit/actions.ts              # EXTEND: + 'trip.create' | 'trip.plan_update' | 'trip.status_change' | 'trip.cancel'
├── auth/permissions.ts           # EXTEND: + 'manage_trips' key (Admin, Operations Manager)
└── index.ts                      # EXTEND: export ./domain/trip-status, ./schemas/trip

apps/web/
├── lib/trips/
│   ├── trips-service.ts          # NEW: createTrip, getTrip(+events+audit+billingStatus), listTrips
│   ├── trip-transitions.ts       # NEW: transitionTripStatus (status-guarded, atomic status+event+audit)
│   ├── trip-plan.ts              # NEW: updateTripPlan (audited; post-Confirmed authorized-review gate)
│   ├── trip-cancellation.ts      # NEW: cancelTrip (5-input validation; missing-config → fail)
│   └── *.test.ts                 # NEW: Vitest integration (dev DB) for each of the above
└── app/api/trips/
    ├── route.ts                  # NEW: GET (list inspector). [create may be exercised via service in tests]
    └── [id]/route.ts             # NEW: GET (detail inspector: trip + billingStatus + events + audit)
```

**Structure Decision**: Web application on the existing monorepo. No new package or service (Constitution I).
The reusable domain lives in `packages/shared/src/domain/trip-status.ts` (mirroring how 001's permission
catalog lives in `shared`), the persistence in `packages/db/schema/*`, and the enforcement in
`apps/web/lib/trips/*` service functions that later slices' route handlers call. This slice's own BFF surface
is limited to the two read-only inspector endpoints under `apps/web/app/api/trips/*`.

## Complexity Tracking

> No Constitution Check violations. No new package, service, broker, or abstraction below the ≥3 threshold.
> This section is intentionally empty.
