# Implementation Plan: Dispatch Assignment and Conflict Warnings

**Branch**: `006-dispatch-assignment` | **Date**: 2026-05-31 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/006-dispatch-assignment/spec.md`

## Summary

This slice builds the **dispatch/assignment write surface** over the existing trip domain: a dispatcher assigns a **driver, vehicle, trailer, and carrier** to a trip and sees **conflict & eligibility warnings** before committing; warnings can be **overridden with a reason** (when permitted); resources can be **reassigned** (superseding prior assignments, retaining history); and the trip is **confirmed** when ready. It adds the new **Dispatch Board** (§15.6) and fills slice 005's reserved shell — the Trip-Detail **assignment panel**, the assigned-driver/vehicle/carrier **filters**, the **"Unassigned"** view, the **assignment row indicator**, and the Home Dashboard **"unassigned trips"** count.

Technical approach: 006 introduces **one new table** — `trip_assignments` (the PRD §14.1 entity SPEC-SLICING assigns to 006) — with a partial unique index enforcing **at most one current assignment per trip**, and supersession columns retaining history. A **pure eligibility evaluator** in `@brazil-tms/shared` implements the §19.2 checks (schedule overlap, resource status, vehicle-type match, carrier eligibility, documentation expired/missing) with a **confirmed company-default block/warn config**; the DB layer gathers context and calls it, and the **BFF enforces** the outcome — conflict authority lives server-side, never in the UI (Constitution III / STACK §6.1). New **assignment service functions** in `@brazil-tms/db` mirror 003's `transitionTripStatus`/`cancelTrip` transaction pattern (guarded status update + `trip_events` + `audit_logs`, one transaction), driving the **existing** `validated→assigned` / `assigned→confirmed` / `assigned→validated` transitions without redefining the machine. The board/detail/dashboard **read models are extended** with assignment data. Authorization reuses the **already-declared `assign_resources`** key (granted to Admin/Ops-Manager/Dispatcher/Fleet-Coordinator but never enforced); 006 is the **first slice to enforce it** — mirroring how 004 first-enforced `import_trips` and 005 `view_all_trips`. Per the spec's clarifications, the carrier approved-for-customer/lane rule is **out of MVP scope** (no approval storage), the block/warn defaults and minimum-required set (driver+vehicle; carrier if subcontracted) are **confirmed config**, the confirm gate **re-checks for BLOCK drift**, and override is `assign_resources`-gated with **BLOCK absolute** — none of these invent customer/document/carrier-approval values (Constitution II).

## Technical Context

**Language/Version**: TypeScript 5.6 (strict); Node.js 20 LTS; pnpm 10 monorepo.

**Primary Dependencies** (existing — **no new runtime deps**): Next.js 15 (App Router) + React 19; Drizzle ORM over `postgres` (server-only); Zod 3.23 (assignment input + board-filter validation, shared by web); Luxon 3 (`America/Sao_Paulo` for schedule-window/expiry math via the existing `documentExpiryState`); **TanStack Query 5** (polling + assignment mutations) + **TanStack Table 8** (board); `next-intl` (pt-BR); shadcn/ui + Radix + lucide-react.

**Storage**: self-hosted Supabase Postgres. **One new table** `trip_assignments` + a partial unique index (`(trip_id) WHERE is_current`) and four partial conflict-lookup indexes. **No new enum** (reuses `resource_status`, `vehicle_type`, `trailer_type`, `ownership_type`, `trip_status`, `trip_event_type`); **no `trips` column change** (current assignment via the partial unique index — single source of truth). New **service functions** + **read-model extensions** (Drizzle `select`/joins) over `trip_assignments` + existing `trips`/`drivers`/`vehicles`/`trailers`/`carriers`/`trip_events`/`audit_logs`. PostgREST/gateway never exposed; service-role key server-only.

**Testing**: Vitest is the primary gate. **Pure unit** (`packages/shared`): `evaluateAssignmentEligibility` over every §19.2 check × severity, `DEFAULT_ASSIGNMENT_POLICY`, `requiredResourcesFor`, the `trip-assignment` Zod schemas, the four new `AuditAction`s, and transition legality (`canTransition` for `validated→assigned`/`assigned→confirmed`/`assigned→validated`). **Service/integration** (`apps/web` lib, dev DB, `describe.skipIf(!DATABASE_URL)`): `assignTrip` happy-path + min-required refusal + single-current-assignment race (`STALE_TRANSITION`) + OVERRIDE_REQUIRED/ASSIGNMENT_BLOCKED; `reassignTrip` supersede+retain with **status unchanged**; `unassignTrip` (`assigned→validated`); `confirmTripAssignment` re-check + BLOCK-drift refusal; `gatherEligibilityContext` overlap query; board/detail/dashboard read models surface assignment fields + the unassigned count. **Playwright** (`e2e/`): assign→confirm, warnings + override (+ empty-reason refusal), reassign history, Dispatch Board, Control Tower assignment filters/"Unassigned" view/row indicator, dashboard count; and **authz** — `assign_resources` holder `200` vs non-holder `403`, view-only roles read but cannot assign. Route HTTP-status + finding payloads are asserted in `e2e/` (no `route.test.ts`).

**Target Platform**: Linux server via Docker Compose (Supabase, app, worker, Caddy). Desktop-first, evergreen browsers (PRD §16). **No worker work** — assignment + conflict checks are synchronous, bounded, indexed BFF operations.

**Project Type**: Web application — existing monorepo (`apps/web` + `packages/{shared,db}`). **No new package, no worker job.**

**Performance Goals**: Assignment attempt + full conflict check returns within **2 s** at the medium design scale (SC-003) via indexed current-assignment lookups; Dispatch Board loads within **3 s** (SC-006). Freshness = **polling** reusing 005's cadence (`CONTROL_TOWER_POLL_MS = 30 s`); no Realtime.

**Constraints**: BFF-only authorization; **conflict authority server-side, never UI** (Constitution III / STACK §6.1); service-role key server-only; gateway/PostgREST never public; **NO** Realtime / Edge Functions / Redis-BullMQ / microservices / route optimizer; freshness via **polling**; **reuses 002/003/005** without redefining the status machine, master data, or audit — assignment drives existing transitions through 003's service pattern; assignment changes **audited** (append-only `audit_logs` + `trip_events`); superseded assignments **retained** (no hard delete); block/warn + required-set **config-driven** (no per-customer code); UI pt-BR; timestamps UTC (displayed `America/Sao_Paulo`).

**Scale/Scope**: **1** new table (`trip_assignments`); **0** new enums; **6** new indexes (1 partial-unique + 4 partial conflict-lookup + 1 trip history); **0** new permission keys — **reuse `assign_resources`, FIRST ENFORCED in 006**; **5 BFF endpoints** (3 new assignment routes: assign/reassign+unassign, confirm, dry-run check; 2 extended reads: board + detail; + dashboard fill); **1** new screen (Dispatch Board) + the assignment panel/filters/view/indicator filling 005's shell; **~4 new shared modules/edits** (eligibility evaluator + policy, `trip-assignment` Zod schema, `TRIP_CRITICAL_FIELDS` + `AuditAction` extensions); **~4 new db functions** (`assignTrip`/`unassignTrip`/`confirmTripAssignment`/`checkAssignment` + `gatherEligibilityContext`) + read-model extensions. **Open items are configurable defaults / deferred policy, not blockers**: carrier approved-for-customer/lane (out of MVP scope, no storage), per-customer severity overrides (config seam, no storage), broader owned-vs-subcontracted policy (§29 Input #6), vehicle-type substitution matrix (exact-match default), turnaround buffer (0-min default) — none invented (Constitution II).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Confirmed against `.specify/memory/constitution.md` (v1.0.0):

- [x] **Simplicity (I)**: One new table — `trip_assignments` — is the **core PRD §14.1 entity** this slice owns (justified, not speculative; required by in-scope DISP-001..009). **No** new enum (`is_current` + supersession replaces an assignment-status enum), **no** new permission key (reuse `assign_resources`), **no** new package, **no** worker, **no** denormalized `trips` column (single source via partial unique index). The eligibility evaluator is **one pure module** in `shared`, not a generic "engine"; assignment services **reuse** the `transitionTripStatus`/`cancelTrip`/`writeAudit`/`loadTripDetail` building blocks (no abstraction below the ≥3 rule). Dispatch Board reuses the extended board read model (no separate endpoint).
- [x] **Scope (II)**: Strictly DISP-001..009 + the Trip Assignment entity + the §15.6 Dispatch Board + the 005-shell fills (SPEC-SLICING 006). Resource recommendation (DISP-010, Later), execution events/exceptions/SLA (007), and documents/billing (008) are out of scope. Items gated on PRD §29 Input #6 (per-customer severity, broader ownership) and the carrier approved-for rule are **labelled configurable defaults / out-of-scope**, **not** marked complete and **not** invented.
- [x] **System-of-record (III)**: Durable state in Postgres. Assignment **drives** the explicit status machine via 003's service pattern (guarded transition + `trip_events` + `audit_logs`, one tx) — the machine, master data, and audit are **not redefined**. Superseded assignments are **retained** (soft-supersede via `is_current`/`superseded_*`, never hard-deleted); `trip_events`/`audit_logs` stay append-only. **Conflict authority is server-side**; the UI's check endpoint only *displays* findings.
- [x] **Authz & secrets (IV)**: Every assignment write goes through the **BFF** and `requirePermission(ctx, "assign_resources")` (first enforcement); reads stay on `view_all_trips`. RLS deferred; service-role key server-only; gateway never exposed. All assignment/reassignment/unassignment/confirmation/override actions are **audited** (`trip.assign`/`trip.reassign`/`trip.unassign`/`trip.confirm`, with the override reason).
- [x] **Config over code (V)**: Block/warn **severity** and the **minimum-required resource set** are data/config (`DEFAULT_ASSIGNMENT_POLICY` + `requiredResourcesFor`), with a per-customer override **seam** — **no per-customer branches**. Customer variation surfaces only as config and i18n labels.
- [x] **Tech constraints**: Freshness is **polling** (TanStack Query `refetchInterval`); **no Realtime, no Edge Functions, no Redis/BullMQ, no microservices, no route optimizer**. One app, no worker activation. Conflict checks are bounded, indexed BFF/domain operations.
- [x] **Workflow**: Short-lived `006-dispatch-assignment` branch → PR to **`dev`**; CI gates (lint/typecheck/build/tests) must pass; PR template used; AI does not merge to `main`.

**Result: PASS.** The single new table is the justified, in-scope core entity of the slice; every other lever (enum, key, package, worker, abstraction) is reused or avoided. **Complexity Tracking is therefore empty.** (Reusing the pre-declared `assign_resources` and first-enforcing it is the constitutionally-preferred DRY choice over adding a key — mirrors 004/`import_trips` and 005/`view_all_trips`.)

### Post-Design re-check (after Phase 1)

Re-evaluated after producing `data-model.md`, `contracts/`, and `quickstart.md`: **still PASS, no new violations.** The data model adds exactly the one justified table (no enum, no `trips` change); contracts add no permission key (reuse `assign_resources`) and keep all conflict authority server-side (the `check` endpoint is read-only/advisory); the eligibility evaluator stayed a single pure `shared` module; severity/required-set remained config. Complexity Tracking remains empty.

## Project Structure

### Documentation (this feature)

```text
specs/006-dispatch-assignment/
├── plan.md                       # This file (/speckit-plan output)
├── research.md                   # Phase 0 — design decisions (R0–R15)
├── data-model.md                 # Phase 1 — trip_assignments table, eligibility evaluator, read-model extensions, migration
├── quickstart.md                 # Phase 1 — setup, run, US-by-US verification, tests
├── contracts/
│   ├── bff-endpoints.md          # assign/reassign · unassign · confirm · check · extended board/detail/dashboard
│   └── permission-matrix.md      # no new key — first enforcement of assign_resources
├── spec.md                       # Feature spec (/speckit-specify + /speckit-clarify)
├── checklists/requirements.md    # Spec quality checklist
└── tasks.md                      # Phase 2 — /speckit-tasks (NOT created by /speckit-plan)
```

### Source Code (repository root) — extends the existing monorepo

```text
packages/shared/src/
├── domain/assignment-eligibility.ts        # NEW: evaluateAssignmentEligibility + DEFAULT_ASSIGNMENT_POLICY + requiredResourcesFor + types
├── domain/trip-status.ts                    # EXTEND: + assignment refs in TRIP_CRITICAL_FIELDS (comment already reserves this)
├── audit/actions.ts                         # EXTEND: + trip.assign / trip.reassign / trip.unassign / trip.confirm (+ ALL_AUDIT_ACTIONS)
├── schemas/trip-assignment.ts               # NEW: assignTripSchema / confirmAssignmentSchema / checkAssignmentSchema
├── schemas/trip-board.ts                    # EXTEND: + assigned / driverId / vehicleId / carrierId filter params
└── index.ts                                 # EXTEND: export the new schema + eligibility modules

packages/db/
├── schema/trip-assignments.ts               # NEW: trip_assignments table + partial-unique + conflict indexes
├── schema/index.ts                          # EXTEND: export tripAssignments
├── migrations/0005_*.sql                    # NEW: drizzle migration (CREATE TABLE + indexes; no enum, no REVOKE, no trips ALTER)
└── src/
    ├── trips/trip-assignments.ts            # NEW: assignTrip / unassignTrip / confirmTripAssignment / checkAssignment / gatherEligibilityContext
    ├── trips/trips-read.ts                  # EXTEND: board (assignment cols + filters) · detail (currentAssignment + history) · dashboard (unassignedTrips count)
    └── index.ts                             # EXTEND: export the new service + read-model functions/types

apps/web/
├── lib/
│   ├── auth/require-auth.ts                 # UNCHANGED: reuse requirePermission(ctx, "assign_resources")
│   ├── trips/trip-assignments.ts            # NEW: server-only re-export of @brazil-tms/db assignment services
│   ├── trips/client.ts                      # EXTEND: useAssignTrip/useReassignTrip/useUnassignTrip/useConfirmAssignment/useAssignmentCheck + assignment filter keys
│   └── trips/views.ts                       # EXTEND: + "unassigned" default view (slot reserved by 005)
├── app/api/trips/[id]/assignment/
│   ├── route.ts                             # NEW: POST assign/reassign · DELETE unassign (assign_resources)
│   ├── confirm/route.ts                     # NEW: POST confirm (assign_resources)
│   └── check/route.ts                       # NEW: POST dry-run eligibility (assign_resources)
├── app/api/trips/route.ts                   # EXTEND: assignment filters + row fields (stays view_all_trips)
├── app/api/trips/[id]/route.ts              # EXTEND: currentAssignment + assignmentHistory in detail
├── app/api/dashboard/summary/route.ts       # EXTEND: fill unassignedTrips
├── app/(shell)/dispatch/page.tsx            # NEW: Dispatch Board (server guard → client board; unassigned-by-pickup + assign/confirm)
├── components/trips/
│   ├── trip-detail/assignment-panel.tsx     # NEW: replaces AssignmentPlaceholder (pickers + live findings + assign/reassign/unassign/confirm)
│   ├── trip-detail/trip-detail-client.tsx   # EXTEND: render AssignmentPanel instead of AssignmentPlaceholder
│   ├── trip-detail/placeholders.tsx         # EXTEND: remove AssignmentPlaceholder export (others untouched)
│   ├── trip-filters.tsx                     # EXTEND: + assigned / driver / vehicle / carrier filters
│   ├── control-tower-table.tsx              # EXTEND: + assignment row indicator/column
│   ├── dispatch/dispatch-board.tsx          # NEW: board client (queue + availability + warnings)
│   └── dispatch/assignment-form.tsx         # NEW: shared assign/override form used by panel + board
├── lib/nav.ts                               # EXTEND: + Dispatch nav (gated assign_resources)
└── messages/pt-BR.json                      # EXTEND: Dispatch namespace, assignment filter/view labels, trip.* audit actions (nested + flat)
```

**Structure Decision**: Web application on the existing monorepo. The new domain logic splits the established way: **pure, DB-free** rules (eligibility evaluator, policy, required-set, Zod) in `@brazil-tms/shared`; **stateful** assignment services + read-model extensions in `@brazil-tms/db` (`trips/trip-assignments.ts` beside 003's `trip-transitions.ts`/`trip-cancellation.ts` and 005's `trips-read.ts`), re-exported server-only via `apps/web/lib/trips/`. UI extends 005's `(shell)` screens/registries and adds the Dispatch Board. No new package, worker, or permission key.

## Complexity Tracking

> No Constitution Check violations. The single new table (`trip_assignments`) is the in-scope PRD §14.1 entity the slice owns — justified under Principle I/III, not speculative. No new enum (supersession + `is_current` instead), no new permission key (reuse `assign_resources`, first-enforced — mirrors 004/005), no new package/worker, no abstraction below the ≥3 threshold (the eligibility evaluator is one concrete pure module; assignment services reuse 003's transaction building blocks), no denormalized `trips` column (single source via partial unique index). This section is intentionally empty.
