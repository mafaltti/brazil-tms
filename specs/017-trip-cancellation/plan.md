# Implementation Plan: Trip Cancellation in Control Tower and Dispatch

**Branch**: `017-trip-cancellation` | **Date**: 2026-07-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/017-trip-cancellation/spec.md`

## Summary

Issue #24 [0001]: no screen offers trip cancellation. The slice-003 cancellation **domain is
complete and tested** (`cancelTrip`: §19.5 five-input enforcement against config-driven
`cancellation_options`, transition guard, status-guarded update, trip event, `trip.cancel` audit,
terminal SLA recompute) — but nothing calls it. This slice is the **exposure layer**:

1. **BFF** — NEW `POST /api/trips/[id]/cancel` (permission `cancel_trip`; dispatcher limited to
   dispatch-phase source statuses per the 2026-07-27 clarification) and NEW
   `GET /api/cancellation-options` (active option rows for the dialog). EDIT
   `POST /api/trips/[id]/status` to refuse `toStatus:"cancelled"` (409 `USE_CANCELLATION_ENDPOINT`)
   — closing the loophole that allowed an unjustified cancellation under `update_trip_status` only.
2. **Domain (minimal)** — `cancelTrip` gains optional `allowedSourceStatuses` (409
   `NOT_CANCELLABLE_BY_ROLE`); shared constant `DISPATCH_PHASE_TRIP_STATUSES` names the §18
   "Dispatcher Limited" boundary. No status-machine change.
3. **UI** — one shared `CancelTripDialog` (motivo / parte responsável / impacto de faturamento —
   all required, pt-BR) triggered from three surfaces: Trip Detail header, Dispatch board row,
   Control Tower table row. Visibility = server-computed `cancelScope` (`any` | `dispatch_phase` |
   `none`) ∩ `canTransition(status, "cancelled")`. Hooks `useCancelTrip` /
   `useCancellationOptions` invalidate the `["trips"]` root; freshness stays 30 s polling.
4. **Seed** — default pt-BR `reason` rows (6) added to the 003 seed; `billing_impact` rows already
   shipped. Config remains editable; business sign-off pending (FR-013).

**No schema change, no migration, no new package, no worker change, no new permission key.**
Durable additions: two BFF routes, one UI dialog + hooks, one shared constant, seed rows, tests.

## Technical Context

**Language/Version**: TypeScript (strict), Node.js 22 · Next.js App Router (BFF) · single Node worker (untouched).

**Primary Dependencies**: existing only — Drizzle ORM, Zod, TanStack Query/Table, shadcn/ui, Luxon, Vitest/Playwright. **No new dependency.**

**Storage**: Postgres (self-hosted Supabase). **No DDL**; new seed rows in `cancellation_options` (`kind='reason'`), idempotent per `(kind, code)`.

**Testing**: Vitest — shared (`trip-status.test.ts` constant shape), db/web integration (`trip-cancellation.test.ts` + route-level coverage for `/cancel`, `/cancellation-options`, `/status` refusal); Playwright — cancel flow on the three surfaces, dispatcher-limit and no-permission matrix rows (extends `permission-coverage.spec.ts`, realizing its lines 16-17 note).

**Target Platform**: Linux server (app + worker), pt-BR UI, `America/Sao_Paulo` (timestamps UTC; `cancelled_at` = server now).

**Project Type**: Web monorepo (existing) — `apps/web`, `packages/{shared,db}`, `workers/` (untouched).

**Performance Goals**: unchanged — one bounded config read (`cancellation_options`, single-digit rows) per dialog open; cancel is a single guarded transaction identical in cost to shipped transitions.

**Constraints**: polling-only (NO Realtime), BFF-only authz (one permission per route — the dispatcher limit is a domain option, not conditional permission logic), service-role key server-only, explicit status machine untouched (16 active values; `cancelled` edges already legal per §12.1).

**Scale/Scope**: ~2 shared edits · ~2 db edits (service opt + seed) · 2 NEW routes + 1 route edit · 1 NEW dialog + 3 surface edits + 3 page-prop edits + hooks + i18n keys · tests/e2e · PRD §30 entry + CLAUDE.md block. No `NEEDS CLARIFICATION` remain (3 resolved with the user 2026-07-27 — see spec Clarifications).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] **Simplicity (I)**: exposes an existing, tested service through the house patterns (route → service; hook → route; dialog → hook). One shared dialog instead of three copies. The only new abstraction is a named constant (`DISPATCH_PHASE_TRIP_STATUSES`) with ≥3 in-slice uses (route guard, UI visibility, tests) encoding a product decision; existing local status sets are deliberately NOT retrofitted (churn without need). No new package/service/layer.
- [x] **Scope (II)**: within MVP scope — PRD §12.1/§15.4-15.6/§18/§19.5 all specify this; issue #24 requests it. The seeded reason list is labeled scaffolding with business sign-off pending (FR-013, 007 precedent) — marked, not silently "complete". Bulk cancel, dispute-entry changes, fee automation: out of scope.
- [x] **System-of-record (III)**: Postgres owns state; the ONLY writer remains `cancelTrip`'s guarded transaction (update + append-only event + audit together). Closing the `/status` loophole *strengthens* explicit-transition integrity: after this slice, `cancelled` is reachable solely with full §19.5 data. History immutable; no deletes.
- [x] **Authz & secrets (IV)**: both new routes behind `requireAuth` + `requirePermission("cancel_trip")` (admin/ops_manager/dispatcher; control_tower has no key — §18 "No" holds). Dispatcher "Limited" enforced in the domain call (race-safe), role mapping in the BFF where `ctx.role` lives. Sensitive action already audited (`trip.cancel`). No new exposure.
- [x] **Config over code (V)**: reasons/billing impacts stay config rows (`cancellation_options`); the seed adds default rows, zero hard-coded lists; no per-customer code.
- [x] **Tech constraints**: NO Realtime (30 s polling covers queue/list refresh), NO Edge Functions, NO Redis/broker, NO microservices; worker untouched; no route optimizer.
- [x] **Workflow**: feature branch `017-trip-cancellation` off `dev`; PR targets `dev`; lint/typecheck/build/tests gates; AI does not merge to `main`.

**Result: PASS** — no violations; two design choices logged below for transparency.

## Project Structure

### Documentation (this feature)

```text
specs/017-trip-cancellation/
├── plan.md              # This file
├── research.md          # Phase 0 — R1 endpoint+loophole, R2 dispatcher limit, R3 options read,
│                        #   R4 seed, R5 dialog/surfaces, R6 errors, R7 docs
├── data-model.md        # Phase 1 — no DDL; existing structures, vocabulary delta, seed rows, read model
├── quickstart.md        # Phase 1 — setup + 10-step manual verification + suites touched
├── contracts/
│   └── trip-cancellation-api.md   # POST /cancel, GET /cancellation-options, /status refusal, hooks
├── checklists/
│   └── requirements.md  # spec quality checklist (all pass; 3 clarifications folded in)
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
packages/shared/src/domain/
├── trip-status.ts                 # EDIT — add DISPATCH_PHASE_TRIP_STATUSES = ["received","assigned",
│                                  #   "confirmed"] as const + JSDoc naming the §18 "Limited" decision
│                                  #   (clarification 2026-07-27). Machine/TRANSITIONS untouched.
└── trip-status.test.ts            # EDIT — constant shape/membership test.

packages/db/src/trips/
└── trip-cancellation.ts           # EDIT — cancelTrip(tripId, input, actorUserId, opts?): optional
                                   #   { allowedSourceStatuses?: readonly TripStatus[] }; after row load,
                                   #   outside-list status → Conflict("NOT_CANCELLABLE_BY_ROLE", pt-BR msg).
                                   #   Race-safe via the existing optimistic status-guarded update.
                                   #   + queryCancellationOptions() (active rows, ordered) for the GET route.

packages/db/seed/
└── trip-domain-sample.ts          # EDIT — seed kind='reason' rows (6 pt-BR defaults; idempotent per
                                   #   (kind,code), same mechanism as the shipped billing_impact block).
                                   #   Update the "reason codes left EMPTY" log line (017 decision).

apps/web/app/api/
├── trips/[id]/cancel/route.ts     # NEW — POST: requireAuth + requirePermission("cancel_trip");
│                                  #   body → {reasonCode, responsibleParty, billingImpact} (client
│                                  #   timestamp IGNORED — server now(), FR-005); dispatcher →
│                                  #   allowedSourceStatuses: DISPATCH_PHASE_TRIP_STATUSES; returns
│                                  #   { item: TripDetail }; errors per contract (R6).
├── cancellation-options/route.ts  # NEW — GET: requirePermission("cancel_trip"); { items } active rows
│                                  #   ordered kind, sort_order (queryReasonCodes route pattern).
└── trips/[id]/status/route.ts     # EDIT — refuse toStatus==="cancelled" with 409
                                   #   USE_CANCELLATION_ENDPOINT (mirrors USE_ASSIGNMENT_ENDPOINT);
                                   #   update the route JSDoc. `disputed` untouched (out of scope).

apps/web/lib/trips/
├── trip-cancellation.ts           # EDIT — re-export queryCancellationOptions alongside cancelTrip.
├── client.ts                      # EDIT — useCancelTrip (POST /cancel; invalidates ["trips"] root) +
│                                  #   useCancellationOptions (GET; config-grade staleness) following
│                                  #   the useAssignTrip/useMarkCompleted house pattern.
└── trip-cancellation.test.ts      # EDIT — allowedSourceStatuses: accepts received/assigned/confirmed,
                                   #   NOT_CANCELLABLE_BY_ROLE on in_transit; existing cases untouched.

apps/web/components/trips/
├── cancel-trip-dialog.tsx         # NEW — single shared dialog: motivo (select, options kind=reason),
│                                  #   parte responsável (CANCELLATION_RESPONSIBLE_PARTIES, pt-BR labels),
│                                  #   impacto de faturamento (select, kind=billing_impact); required-field
│                                  #   errors inline (FR-006); CANCELLATION_NOT_CONFIGURED empty state
│                                  #   (FR-011); confirm → useCancelTrip.
├── trip-detail/trip-detail-client.tsx  # EDIT — compose the dialog + header "Cancelar viagem" action;
│                                  #   visible iff cancelScope covers currentStatus AND
│                                  #   canTransition(currentStatus,"cancelled").
├── dispatch/dispatch-board.tsx    # EDIT — per-row "Cancelar" action beside "Atribuir" (queue is
│                                  #   status=received ⊂ dispatch phase, so any cancelScope ≠ none shows it).
└── control-tower-table.tsx        # EDIT — per-row cancel action beside quick-assign, same visibility rule.

apps/web/app/(shell)/
├── trips/page.tsx                 # EDIT — compute cancelScope from role (admin/ops_manager → "any";
│                                  #   dispatcher → "dispatch_phase"; else "none") and pass to the table.
├── trips/[id]/page.tsx            # EDIT — same, pass to detail client.
└── dispatch/page.tsx              # EDIT — same, pass to the board.

apps/web/messages/pt-BR.json       # EDIT — Trips.cancel* dialog keys (title, fields, confirm, errors,
                                   #   not-configured state). AuditActions.trip_cancel ALREADY EXISTS.

# Tests / e2e (apps/web)
apps/web/e2e/trip-cancellation.spec.ts  # NEW — US1 detail flow (ops_manager), US2 dispatch row
                                   #   (dispatcher), US3 control-tower row; missing-element rejection;
                                   #   dispatcher limit (no action + 409 on direct POST for in_transit);
                                   #   /status "cancelled" → USE_CANCELLATION_ENDPOINT (FR-008).
apps/web/e2e/permission-coverage.spec.ts  # EDIT — cancel_trip rows (control_tower 403; dispatcher
                                   #   limited), realizing the existing lines 16-17 note.

# UNCHANGED machinery (verified) — status machine TRANSITIONS; import engine; assignment endpoints/
#   evaluator; dispute entry/exit; worker jobs; billing/export; audit write path; permissions matrix
#   (cancel_trip grants already correct: admin, operations_manager, dispatcher; control_tower none).

# Docs
docs/PRD.md                        # EDIT — §30 decision entry: Dispatcher "Limited" = dispatch phase
                                   #   (received/assigned/confirmed), 2026-07-27; default reason seed
                                   #   shipped as labeled scaffolding, business sign-off pending.
CLAUDE.md                          # EDIT — SPECKIT block → point at this plan.
```

**Structure Decision**: Web monorepo (existing). The feature radiates from the shipped
`cancelTrip` service outward: one domain option + one shared constant, two thin BFF routes, one
shared dialog reused by three surfaces, seed rows. No new directories beyond the two route folders,
no new packages, layers, or i18n namespaces.

## Complexity Tracking

| Design choice (logged for transparency) | Why acceptable | Simpler/other alternative rejected because |
|---|---|---|
| **Dedicated `/cancel` endpoint + `/status` refusal** (instead of teaching `/status` to cancel) | Keeps the house invariant "one permission per route" and one input shape per route; makes `cancelled` reachable only with full §19.5 data (SC-002); mirrors the shipped `USE_ASSIGNMENT_ENDPOINT` precedent exactly. | Conditional `cancel_trip` enforcement inside `/status` would branch permissions AND body schema on `toStatus` — more surface, harder matrix testing; leaving `/status` open keeps an unjustified-cancellation loophole. |
| **`allowedSourceStatuses` option on `cancelTrip`** (domain-level dispatcher limit) | The §18 "Limited" rule becomes un-bypassable by any future caller and race-safe (checked status = optimistically guarded status). Optional param, zero impact on existing callers/tests. | Route-side pre-check duplicates the row load and is not race-safe alone; a `cancel_trip_any` permission key adds matrix surface for one role distinction the PRD names "Limited". |
