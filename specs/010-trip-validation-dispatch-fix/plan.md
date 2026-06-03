# Implementation Plan: Trip Validation Action & Dispatch Queue Hardening

**Branch**: `010-trip-validation-dispatch-fix` | **Date**: 2026-06-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/010-trip-validation-dispatch-fix/spec.md`

## Summary

This is a **corrective close-out slice** that fixes **GitHub issue #11**: an imported or manually-created trip is always created in **`received`** (slice 003's `createTrip` default; import never transitions — slice 004), but **no shipped product surface advances it to `validated`**, so it can never be assigned through the UI — even though `received → validated` is a **legal edge** in the single status machine (`packages/shared/src/domain/trip-status.ts:85`) and the generic status endpoint already performs it. The user-visible symptom is that the Dispatch Board lists non-assignable trips (`scope=active` → all 12 active statuses) and clicking **Atribuir** on a `received` trip dies with a misleading `ILLEGAL_TRANSITION` ("reassignment only") because the assignment route routes every non-`validated` `expectedFromStatus` into `reassignTrip` (`route.ts:32-35` → `trip-assignments.ts:471-476`).

Technical approach — the **smallest correct change**, adding **NOTHING durable** (no new table, enum, migration, permission key, package, runtime dependency, or worker job): **(1) Validate action** — a new, small `ValidateAction` component on **Trip Detail** (005) shown only for `received`/`validation_error`, which calls the **existing** `POST /api/trips/[id]/status` endpoint (already gated `update_trip_status`, already accepts `received → validated` / `validation_error → received` via `transitionTripStatus`, which writes the append-only `trip_events` + `audit_logs` rows and recomputes SLA in one tx). It **reuses the existing generic status client** `useRecordMilestone` (the `/status` mutation hook, despite its 007-era name) — **no new hook, endpoint, service, or permission**, and per **Constitution III** it never re-implements the status machine. **(2) Dispatch queue hardening** — one constant in `dispatch-board.tsx:30` changes from `assigned=false&scope=active` to `status=validated&assigned=false`; the board read model already honors an explicit `status` filter (`trip-board.ts` `oneOrMany(z.enum(TRIP_STATUSES))` → `trips-read.ts:341-343`, which also suppresses the active-scope default), so **no read-model code change**. **(3) Assignment-error clarity** — `assignment/route.ts` replaces the client-driven ternary with an **explicit by-status branch** (`validated → assignTrip`; `assigned`/`confirmed → reassignTrip`; **else → `Conflict("NOT_ASSIGNABLE", …)`**) covering **all** non-assignable statuses, wired through the existing `Conflict → 409` mapping; `NOT_ASSIGNABLE` is added to the `assignment-form.tsx` `ERROR_CODES` allowlist and as a `Dispatch.errors.NOT_ASSIGNABLE` pt-BR label so it does not degrade to `REQUEST_FAILED`. **(4) Seed refresh** — `trip-domain-sample.ts` advances one demo trip to `validated` (and one to `assigned`) **through the transition/assignment services** (never a raw status write) so the hardened queue and the validate→assign flow are demonstrable and e2e-testable. Per **Constitution II** nothing is invented: at MVP `received → validated` is a **deliberate operator promotion** (import already ran the §11.2 checks and does not transition trips); auto-validate-on-import and per-customer validation rules are **deferred**, not built.

## Technical Context

**Language/Version**: TypeScript 5.6 (strict); Node.js 20 LTS; pnpm 10 monorepo.

**Primary Dependencies** (existing — **no new runtime deps**): Next.js 15 (App Router) + React 19; Drizzle ORM over `postgres` (server-only, seed only here); Zod 3.23 (`transitionTripSchema`/`assignTripSchema` reused, unchanged); Luxon 3 (`America/Sao_Paulo`); **TanStack Query 5** (the reused `useRecordMilestone` + board polling); **TanStack Table 8** (board); `next-intl` (pt-BR); shadcn/ui + Radix + lucide-react.

**Storage**: self-hosted Supabase Postgres. **No schema change** — **0** new tables, **0** new enums, **0** migrations. The slice only exercises already-legal `trip_status` edges (`received → validated`, `validation_error → received`, `validated → assigned`) and reuses the append-only `trip_events`/`audit_logs` writes performed by the existing `transitionTripStatus`. The only `packages/db` change is the **seed** (`packages/db/seed/trip-domain-sample.ts`). PostgREST/gateway never exposed; service-role key server-only.

**Testing**: Vitest + Playwright (per STACK §3.13). **Unit (`apps/web/lib`)**: extend `messages.test.ts` to assert no dotted keys and that `Dispatch.errors.NOT_ASSIGNABLE` exists (next-intl INVALID_KEY guard — see memory). **e2e (`apps/web/e2e`, vs a prod build, `--workers=1`, seeded via `db:seed:e2e`)**: a new `trip-validate.spec.ts` (received→validate via Trip Detail → trip becomes `validated` + writes a `status_change` event/audit; `update_trip_status` holder `2xx` vs non-holder `403`; validate not offered for non-`received`/`validation_error`); extend `dispatch-board.spec.ts` (queue shows only `validated` unassigned; assign succeeds) and `dispatch-assignment.spec.ts`/a new assertion (assigning a `received` and an `in_transit` trip → `409 NOT_ASSIGNABLE` with the pt-BR message; `validated` still assigns; reassign from `assigned`/`confirmed` still works — regression). Route HTTP-status assertions live in e2e (repo convention — no `route.test.ts`).

**Target Platform**: Linux server via Docker Compose (Supabase, app, worker, Caddy). Desktop-first, evergreen browsers (PRD §16). **No worker work** — validate + assignment are synchronous BFF operations.

**Project Type**: Web application — existing monorepo (`apps/web` + `packages/{shared,db}`). **No new package, no worker job.**

**Performance Goals**: Validate is a single guarded status transition (well within the §21.2 < 2 s detail budget); the hardened dispatch query is **narrower** than today (an indexed `current_status = 'validated'` + `assignment IS NULL` lookup) so it only improves board load (< 3 s, SC-006 from 006). Freshness = **polling** (reuses 005/006 cadence); no Realtime.

**Constraints**: BFF-only authorization (`update_trip_status` for validate, `assign_resources` for assignment — both already enforced); status authority server-side, never UI; service-role key server-only; gateway/PostgREST never public; **NO** Realtime / Edge Functions / Redis-BullMQ / microservices / route optimizer; freshness via **polling**; **reuses 003/005/006** without redefining the status machine or adding a write path; validate is **audited** (append-only `audit_logs` + `trip_events`, source `operator_manual`); UI pt-BR; timestamps UTC (displayed `America/Sao_Paulo`).

**Scale/Scope**: **0** new tables / enums / migrations / permission keys / packages / worker jobs / runtime deps. **1** BFF route **changed** (`assignment/route.ts` — explicit branch + `NOT_ASSIGNABLE`); **1** BFF route **reused unchanged** (`status/route.ts` for validate). **1** new UI component (`validate-action.tsx`) + **3** UI edits (`trip-detail-client.tsx` render it; `dispatch-board.tsx` query constant + doc comment; `assignment-form.tsx` `ERROR_CODES`). **1** i18n edit (`pt-BR.json` — `Dispatch.errors.NOT_ASSIGNABLE` + `Trips.detail` validate labels). **1** seed edit. **0** shared-package changes. **No PRD §29 gate**; one deferred (non-blocking) product decision (auto-validate / per-customer validation rules).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Confirmed against `.specify/memory/constitution.md` (v1.0.0):

- [x] **Simplicity (I)**: The minimal diff — a button that calls an **existing** endpoint, a one-token query change, and an explicit branch with one new error string. **No** new permission key (reuse `update_trip_status`), **no** new endpoint/service/hook (reuse `POST /status` + `useRecordMilestone`), **no** new table/enum/migration/package/worker, **no** new abstraction (well below the ≥3 rule). `NOT_ASSIGNABLE` is a plain `Conflict` code (the `Conflict` class takes a free-form string — `errors.ts`), not a new type system.
- [x] **Scope (II)**: Strictly closes issue #11 over shipped slices 003/005/006. Auto-validate-on-import, per-customer validation rules, a `validate_trip` key, bulk validate, and a board-level validate action are **deferred** (Future Enhancements), **not** built and **not** marked complete. No PRD §29 input is invented (the validate transition runs on no criteria beyond what import already checked).
- [x] **System-of-record (III)**: Durable state in Postgres. Validate **drives** the explicit status machine through the **single** `transitionTripStatus` service (guarded transition + append-only `trip_events` + `audit_logs`, one tx; SLA recompute) — the machine is **not** redefined and **no parallel status-write path** is created. The seed advances trips **through the services**, never a raw `UPDATE`. `trip_events`/`audit_logs` stay append-only.
- [x] **Authz & secrets (IV)**: Validate goes through the BFF `POST /status` route, already `requirePermission(ctx, "update_trip_status")`; assignment stays on `assign_resources`. RLS deferred; service-role key server-only; gateway never exposed. Validate is **audited** (`trip.status_change`, source `operator_manual`).
- [x] **Config over code (V)**: No customer-specific behavior added; validation criteria are **not** hardcoded or invented (deliberate promotion at MVP). No per-customer branch.
- [x] **Tech constraints**: Freshness is **polling**; **no Realtime, no Edge Functions, no Redis/BullMQ, no microservices, no route optimizer**. One app, no worker activation.
- [x] **Workflow**: Short-lived `010-trip-validation-dispatch-fix` branch (off `dev`) → PR to **`dev`**; CI gates (lint/typecheck/build/tests) must pass; PR template used; **AI does not merge to `main`**.

**Result: PASS.** Every lever (table, enum, key, package, worker, dependency, abstraction, write path) is **reused or avoided**; the slice adds only UI + one route branch + one error label + a seed tweak. **Complexity Tracking is empty.**

### Post-Design re-check (after Phase 1)

Re-evaluated after producing `research.md`, `data-model.md`, `contracts/`, and `quickstart.md`: **still PASS, no new violations.** The data model confirms **zero** durable additions (the data-model "delta" is *none* — only existing legal edges exercised); contracts add **no** permission key (reuse `update_trip_status`/`assign_resources`) and **no** new endpoint (validate reuses `/status`; assignment route gains one `Conflict` code); the Validate UI reuses the existing status client. Complexity Tracking remains empty.

## Project Structure

### Documentation (this feature)

```text
specs/010-trip-validation-dispatch-fix/
├── plan.md                       # This file (/speckit-plan output)
├── research.md                   # Phase 0 — design decisions (R1–R11)
├── data-model.md                 # Phase 1 — "no durable change": legal edges exercised, audit reuse
├── quickstart.md                 # Phase 1 — setup, run, US-by-US verification, tests
├── contracts/
│   ├── bff-endpoints.md          # reused /status (validate) · changed /assignment (NOT_ASSIGNABLE) · board query
│   └── permission-matrix.md      # no new key — validate reuses update_trip_status; assignment reuses assign_resources
├── spec.md                       # Feature spec (/speckit-specify)
├── checklists/requirements.md    # Spec quality checklist
└── tasks.md                      # Phase 2 — /speckit-tasks (NOT created by /speckit-plan)
```

### Source Code (repository root) — extends the existing monorepo

```text
packages/db/
└── seed/trip-domain-sample.ts                # EXTEND: advance one demo trip → validated, one → assigned VIA the services (not raw UPDATE); keep one in received

apps/web/
├── app/api/trips/[id]/
│   ├── status/route.ts                        # UNCHANGED: reused by validate (already update_trip_status; already accepts received→validated)
│   └── assignment/route.ts                    # EXTEND: explicit by-status branch (validated→assign · assigned/confirmed→reassign · else→Conflict("NOT_ASSIGNABLE", …)); update docstring code list
├── components/trips/
│   ├── trip-detail/validate-action.tsx        # NEW: Validate/«revalidate» affordance for received/validation_error; reuses useRecordMilestone → /status; Trips.detail labels + error mapping
│   ├── trip-detail/trip-detail-client.tsx     # EXTEND: render <ValidateAction> when currentStatus ∈ {received, validation_error}
│   ├── dispatch/dispatch-board.tsx            # EXTEND: DISPATCH_QUERY → "status=validated&assigned=false&sort=pickupStart" (+ update the doc comment)
│   └── dispatch/assignment-form.tsx           # EXTEND: add "NOT_ASSIGNABLE" to ERROR_CODES (so it maps to Dispatch.errors.NOT_ASSIGNABLE, not REQUEST_FAILED)
├── lib/trips/client.ts                        # UNCHANGED: reuse useRecordMilestone (the generic POST /status mutation) for validate
└── messages/pt-BR.json                        # EXTEND: Dispatch.errors.NOT_ASSIGNABLE + Trips.detail validate labels (validateAction/validateHint/revertToReceived/validating)

apps/web/e2e/
├── trip-validate.spec.ts                      # NEW: received→validate→validated (+ event/audit); holder 2xx vs non-holder 403; not offered off-status
├── dispatch-board.spec.ts                     # EXTEND: queue shows only validated-unassigned; queued trip assigns
└── dispatch-assignment.spec.ts                # EXTEND: received/in_transit assign → 409 NOT_ASSIGNABLE (pt-BR); validated assigns; reassign still works

apps/web/lib/
└── messages.test.ts                           # EXTEND: no dotted keys; Dispatch.errors.NOT_ASSIGNABLE present
```

**Structure Decision**: Web application on the existing monorepo. The Validate action is a **003 lifecycle transition surfaced on the 005 Trip Detail screen** via a new small client component that reuses the existing `/status` endpoint + `useRecordMilestone` hook (no backend change for validate). The dispatch hardening and assignment-error clarity are **006** edits (board query constant + assignment route branch + form error allowlist + i18n). The only `packages/db` touch is the seed. No new package, worker, permission key, table, enum, or migration.

## Complexity Tracking

> No Constitution Check violations. This slice is the minimal corrective diff over shipped slices 003/005/006: it **reuses** the existing status-transition endpoint/service/permission and the existing status machine, **avoids** every durable addition (table, enum, migration, permission key, package, worker, dependency), and introduces **no** abstraction (the single new component is concrete; the single new `Conflict` code is a plain string). This section is intentionally empty.
