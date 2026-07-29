# Implementation Plan: Auto-Validate Imported Trips

**Branch**: `014-auto-validate-imports` | **Date**: 2026-06-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/014-auto-validate-imports/spec.md`

## Summary

Imported trips currently land in trip status `received`, but assignment requires `validated`
(`received → validated → assigned`), and there is **no operator UI** to make that hop — so every
imported trip is stranded before dispatch, and the Expedição queue offers "Atribuir" actions that fail
with `ILLEGAL_TRANSITION`. Since the import pipeline already validates every row, this slice **collapses
the redundant trip-validation step**: applied import rows that **create a new trip** make that trip
**born `validated`** (immediately assignable), and the dispatch queue is narrowed to validated-only so it
never offers an unassignable action.

Technical approach (born-validated, decided in spec §Clarifications): give the promoted `createTrip`
service an **optional `initialStatus` parameter** (default `"received"`); the **two** `createTrip` call
sites in `confirm-import` pass `"validated"`. The trip is written directly in `validated` inside
`createTrip`'s single transaction (never first persisted as `received`), so no worker-crash window can
strand it; the existing `trip.create` audit captures `validated` automatically. **Update** rows
(`updateTripPlan`) and every other `createTrip` caller are untouched — they keep `received`. The dispatch
queue change is a one-line query-string edit (`scope=active` → `status=validated`). **Adds nothing
durable**: no table, column, enum, migration, permission, package, worker job, or dependency.

## Technical Context

**Language/Version**: TypeScript (strict), Node.js 22 · Next.js App Router (BFF) · single Node worker (pg-boss).

**Primary Dependencies**: existing only — Drizzle, Zod, TanStack Query/Table, Luxon, shadcn/ui, Playwright/Vitest. **No new dependency.**

**Storage**: Postgres (self-hosted Supabase). **No schema change** — reuses the existing `trips.current_status` enum value `validated`; no migration.

**Testing**: Vitest (worker integration `confirm.test.ts`; db/web unit), Playwright (e2e `trip-import.spec.ts`, `dispatch-board.spec.ts`).

**Target Platform**: Linux server (Docker Compose: app + worker), pt-BR UI, `America/Sao_Paulo`.

**Project Type**: Web (Next.js BFF + worker) in a monorepo (`apps/web`, `packages/{shared,db}`, `workers/`).

**Performance Goals**: unchanged — born-validated removes one prospective status write vs. a create-then-transition design; confirm stays a per-row best-effort batch.

**Constraints**: polling-only (no Realtime); BFF-only authz; service-role key server-only; explicit enumerated status machine (Constitution III) — born-validated is an **initial** insert status, not a transition, so the legal-transition table is not weakened; subsequent changes still route through `transitionTripStatus`.

**Scale/Scope**: a small, bounded corrective slice — 1 db-service signature edit (+2 call-site args), 1 worker comment edit, 1 client query-string edit; ~3 test files touched. No `NEEDS CLARIFICATION` remain (resolved in spec §Clarifications, 2026-06-07).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] **Simplicity (I)**: minimal diff — one backward-compatible optional param on an existing service, two call-site arguments, one query string, plus test updates. No new abstraction, package, service, or layer; born-validated is **simpler** than the rejected create-then-transition (one transaction, no recovery logic).
- [x] **Scope (II)**: within execution MVP scope; corrective fix to the import→dispatch flow. The auto-validate-on-import policy is a **labeled decision** (FR-009: import-time per-row validation satisfies the PRD §11 trip-validation gate) — not a §29-gated, customer-signed-off surface, and not marked as new product scope. Manual-trip-create staying `received` and a manual "Validar" UI remain explicitly out of scope.
- [x] **System-of-record (III)**: Postgres owns state; status stays an explicit enum (reuses `validated`); the trip is created atomically with its `trip.create` audit recording `validated` (auditable history preserved); original-plan immutability, `trip_events`, and `audit_logs` are untouched. The legal-transition machine is **not bypassed** — born-validated sets an *initial* status at insert; transitions out of `validated` still go through the guarded `transitionTripStatus`. Update rows never change an existing trip's status.
- [x] **Authz & secrets (IV)**: no new endpoint, role, or exposure. `confirm-import` runs in the server-only worker; the dispatch queue change hits the already-authorized BFF `GET /api/trips`. No audit surface lost (the `trip.create` audit is unchanged in shape, only its recorded status differs).
- [x] **Config over code (V)**: the one shared import engine is untouched; no per-customer branch. Auto-validation is a **system-wide policy**, not customer variation.
- [x] **Tech constraints**: no Realtime/Edge/Redis/microservices/route-optimizer; polling unchanged; Postgres-backed queue + single worker unchanged.
- [x] **Workflow**: feature branch `014-…` off `dev`; PR targets `dev`; CI gates (lint/typecheck/build/tests) apply; AI does not merge to `main`.

**Result: PASS** (one design choice logged below for transparency — not a violation).

## Project Structure

### Documentation (this feature)

```text
specs/014-auto-validate-imports/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions (consolidated from spec §Clarifications) + code-grounded findings
├── data-model.md        # Phase 1 — status entry-point change; createTrip param; NO durable change
├── quickstart.md        # Phase 1 — how to verify (import→confirm→Validada→assign; update keeps status; queue=validated)
├── contracts/
│   └── auto-validate-imports.md   # createTrip signature delta + confirm-import behavior + dispatch query contract
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
packages/db/src/trips/
└── trips-service.ts            # EDIT — createTrip gains optional `initialStatus: TripStatus = "received"`
                                #        (3rd param, after actorUserId); insert (line 63) + trip.create audit
                                #        (line 85) use it instead of hardcoded "received". Default = no behavior change.

workers/jobs/confirm-import/
└── index.ts                    # EDIT — the TWO createTrip sites (lines 149, 171) pass "validated";
                                #        update the header comment ("import never transitions status" →
                                #        "newly created trips are born validated"). updateTripPlan paths UNCHANGED.

apps/web/components/trips/dispatch/
└── dispatch-board.tsx          # EDIT — DISPATCH_QUERY (line 30): "assigned=false&scope=active&sort=pickupStart"
                                #        → "assigned=false&status=validated&sort=pickupStart".

# UNCHANGED (verified) — do NOT touch
apps/web/lib/imports/manual-create.ts        # manual trip-create keeps default "received" (out of scope)
apps/web/app/api/trips/route.ts              # board GET already parses status=validated; manual POST unchanged
packages/db/src/trips/trip-transitions.ts    # transitionTripStatus untouched (born-validated, not used by import)
packages/shared/src/schemas/trip*.ts         # CreateTripInput unchanged (status is a fn param, not file data)

# Tests
workers/jobs/confirm-import/confirm.test.ts  # EDIT line 167 "received"→"validated" (+ rename the test);
                                             # ADD: (a) update row does NOT downgrade an existing validated/assigned
                                             #          trip; (b) a confirm-created trip assigns immediately (validated→assigned).
apps/web/e2e/dispatch-board.spec.ts          # ADD — seed a `received` trip alongside the validated one; assert the
                                             # Expedição queue lists ONLY the validated (received is excluded).
apps/web/e2e/trip-import.spec.ts             # EDIT — post-confirm, assert created trips show "Validada" (not "Recebida").

# UNCHANGED tests (verified): manual-create.test.ts (manual stays received), trips-service.test.ts (default received),
# import-batches-service.test.ts (batch status, not trip status), trip-transitions.test.ts + all dispatch e2e
# (already seed currentStatus:"validated"), messages.test.ts (no new i18n keys).
```

**Structure Decision**: Web monorepo (existing). Work concentrates in one db service (`createTrip`), the
`confirm-import` worker, and one dispatch client component. No new directories, packages, layers, i18n
keys, migrations, or endpoints.

## Complexity Tracking

| Design choice (logged for transparency) | Why acceptable | Simpler alternative rejected because |
|---|---|---|
| **Born-validated via a `createTrip` param** instead of reusing `transitionTripStatus(received → validated)` | The slice's whole goal is *no trip stranded in `received`*. Born-validated is **atomic** (one transaction), so no worker crash between create and validate can re-strand a trip — verified safe across all crash/re-run orderings (a re-resolved `update` deliberately doesn't touch status). `createTrip` is still **reused** (creation + `trip.create` audit), not re-implemented; the status machine is not weakened (transitions *out* of `validated` stay guarded). The param is backward-compatible (default `received`), so all 11 other callers are unchanged. | **Create-then-transition** uses two separate transactions (`transitionTripStatus` opens its own), leaving a crash window where an applied trip sits in `received`; a confirm re-run skips applied rows (or re-resolves to a status-preserving `update`), so it would **never recover** — reintroducing the exact bug. Making it robust would add recovery logic (more code) for no benefit. A raw post-create status `UPDATE` was rejected outright (Constitution III: no unaudited/ad-hoc status writes). |

*The shared `createTrip` signature change is a backward-compatible optional parameter (default preserves
every existing caller); it adds no durable surface and re-uses the existing creation+audit path, so it is
fully within Principle I rather than a tracked violation.*
