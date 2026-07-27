# Research — Trip Cancellation in Control Tower and Dispatch (017)

**Date**: 2026-07-27 · **Spec**: [spec.md](./spec.md)

All decisions below were made against the shipped codebase (branch point: `dev` after slice 015).
Ground truth inventory: the slice-003 cancellation **domain is complete and tested** —
`cancelTrip(tripId, input, actorUserId)` (`packages/db/src/trips/trip-cancellation.ts`) parses
`cancelTripSchema`, validates reason/billing-impact against ACTIVE `cancellation_options` rows,
checks `canTransition(current, "cancelled")` before the transaction, performs a status-guarded
update, appends the `status_change` trip event, writes the `trip.cancel` audit row, and recomputes
SLA (terminal branch clears risk + auto-resolves alerts). **Nothing calls it** outside its own test:
no BFF route, no hook, no UI on any of the three surfaces.

## R1 — Expose `cancelTrip` via a dedicated endpoint; close the `/status` loophole

**Decision**: Add `POST /api/trips/[id]/cancel` (requires `cancel_trip`) as the ONLY path to
`cancelled`, and extend `POST /api/trips/[id]/status` to refuse `toStatus: "cancelled"` with a
`USE_CANCELLATION_ENDPOINT` 409 — exactly the pattern that route already applies to
assignment-phase targets (`ASSIGNMENT_PHASE_STATUSES` → `USE_ASSIGNMENT_ENDPOINT`).

**Rationale**: Today `/status` accepts `toStatus:"cancelled"` under only `update_trip_status`,
bypassing every §19.5 requirement (no reason/party/impact) and the `cancel_trip` permission —
the e2e even documents the *intent* that `cancel_trip` be "enforced conditionally inside the
status-transition handler" (`apps/web/e2e/permission-coverage.spec.ts:16-17`), which the handler
never did. A dedicated endpoint keeps one permission per route (house pattern) instead of
conditional permission logic inside `/status`. `disputed` as a `/status` target is **out of scope**
(dispute entry belongs to 008/009 surfaces; changing it here risks breaking the dispute flow).

**Alternatives rejected**: (a) conditional `cancel_trip` enforcement inside `/status` when
`toStatus === "cancelled"` — mixes two permissions and two input shapes in one route; the body
would need the §19.5 fields only sometimes. (b) UI-only exposure calling `/status` — leaves the
loophole and skips justification entirely.

## R2 — Dispatcher "Limited" = dispatch-phase source statuses, enforced in the domain call

**Decision** (user clarification 2026-07-27): a Dispatcher may cancel only trips whose current
status is `received`, `assigned`, or `confirmed`. Admin and Ops Manager may cancel any legally
cancellable trip. Mechanically:

- Add a shared constant `DISPATCH_PHASE_TRIP_STATUSES = ["received","assigned","confirmed"] as const`
  to `packages/shared/src/domain/trip-status.ts` — this is now a named product concept (the §18
  "Limited" boundary) used by the BFF guard **and** the UI visibility rule (≥3 uses in this slice).
- `cancelTrip` gains an optional `opts?: { allowedSourceStatuses?: readonly TripStatus[] }`. When
  present and `row.currentStatus` is not in the list, throw `Conflict("NOT_CANCELLABLE_BY_ROLE")`.
  The check runs after the row load; the existing optimistic `WHERE current_status = <checked>`
  update makes it race-safe (a concurrent advance yields `STALE_TRANSITION`, never a bypass).
- The route passes `allowedSourceStatuses: DISPATCH_PHASE_TRIP_STATUSES` iff `ctx.role === "dispatcher"`
  (the only `cancel_trip` holder besides `admin`/`operations_manager`,
  `packages/shared/src/auth/permissions.ts`).

**Rationale**: enforcement lives with the other cancellation invariants in the domain service (can't
be bypassed by a future second caller); the role→scope mapping stays in the BFF where `ctx.role`
lives, mirroring how routes already choose behavior from context. Existing sets
(`ASSIGNMENT_PHASE_STATUSES` in `status/route.ts`, `ASSIGNABLE_STATUSES` in `assignment-panel.tsx`)
carry their own local semantics and are **not** retrofitted (churn without in-scope need).

**Alternatives rejected**: a second permission key (`cancel_trip_any`) — permission-matrix surface
for a single role distinction the PRD already expresses as "Limited"; pre-loading the trip in the
route to check phase — duplicates the service's load and is not race-safe on its own.

## R3 — Serve the option lists via a small read endpoint

**Decision**: Add `GET /api/cancellation-options` returning the ACTIVE rows of both kinds, ordered
by `sort_order`: `{ items: [{ kind, code, labelPt, sortOrder }] }`. Gate with `cancel_trip` (only
users who can cancel ever need the lists). Query helper follows the `queryReasonCodes` pattern
(`apps/web/app/api/reason-codes/route.ts` — which serves **exception** reason codes and must not be
confused or extended; `cancellation_options` is a distinct 003 table).

**Alternatives rejected**: embedding options in the trip detail DTO (bloats every trip read for a
rarely-used dialog); reusing `/api/reason-codes` (different table, different domain, explicit 007
decision to keep them apart).

## R4 — Seed default pt-BR cancellation reasons (billing impacts already seeded)

**Decision** (user clarification 2026-07-27): extend the 003 seed
(`packages/db/seed/trip-domain-sample.ts`) to also seed the `reason` kind with a default pt-BR set
(e.g. `cancelled_by_customer` "Cancelado pelo cliente", `no_vehicle_available` "Sem veículo
disponível", `no_driver_available` "Sem motorista disponível", `weather_road` "Clima/estrada",
`documentation_issue` "Problema de documentação", `other` "Outro"), idempotent per `(kind, code)`
exactly like the existing `billing_impact` block (`no_charge`/`cancellation_fee`/`manual_review`,
already seeded). Business sign-off on the final list stays open (spec FR-013; 007 precedent);
the list is config — admins can deactivate/add rows without code.

**Alternatives rejected**: leaving `reason` empty (feature ships dark — user chose otherwise);
a new migration inserting rows (seeds are the repo's mechanism for default config data, migrations
are for schema/backfill).

## R5 — One shared dialog, three thin triggers; polling freshness

**Decision**: one `CancelTripDialog` component (shadcn/ui dialog + the existing form patterns)
collecting reason (select, from options), responsible party (select over the shared
`CANCELLATION_RESPONSIBLE_PARTIES` with pt-BR labels), billing impact (select, from options), and a
confirm; used by (1) a Trip Detail header action, (2) a Dispatch board row action, (3) a Control
Tower table row action. Mutations via a `useCancelTrip` hook following the house TanStack pattern
(`apps/web/lib/trips/client.ts` — cf. `useAssignTrip`/`useMarkCompleted`), invalidating the
`["trips"]` root so list/detail/queue refresh; freshness elsewhere remains the existing 30 s polling
(constitution: NO Realtime). The BFF **ignores any client-supplied timestamp** — the route passes
only `{reasonCode, responsibleParty, billingImpact}` to the service, so `cancelledAt` is always
server `now()` (spec FR-005).

**Visibility rule** (computed server-side per page, passed as a prop like the existing `canAssign`):
`cancelScope = "any"` (admin/ops manager) | `"dispatch_phase"` (dispatcher) | `"none"` — the action
renders only when the scope covers the trip's current status AND `canTransition(status, "cancelled")`.

**Alternatives rejected**: per-surface bespoke dialogs (3 near-copies violates DRY at birth);
optimistic row removal (the guard can refuse — render from refetched truth instead).

## R6 — Error surface

The route maps existing domain errors; no new codes beyond `NOT_CANCELLABLE_BY_ROLE`:
`ZodError` → 400 (missing element identified, FR-006); `Forbidden` → 403 (no `cancel_trip`);
`NOT_FOUND` → 404; `NOT_CANCELLABLE` / `STALE_TRANSITION` / `CANCELLATION_NOT_CONFIGURED` /
`INVALID_REASON_CODE` / `INVALID_BILLING_IMPACT` / `NOT_CANCELLABLE_BY_ROLE` → 409 via the
existing `handleRouteError`/`Conflict` machinery. The dialog surfaces the pt-BR messages already
emitted by the service; `CANCELLATION_NOT_CONFIGURED` additionally gets a friendly empty-state in
the dialog when the options query returns an empty kind (spec FR-011).

## R7 — Documentation deltas

`docs/PRD.md` §30 gains one decision entry (Dispatcher "Limited" = dispatch phase; default reason
seed pending sign-off). §18 matrix text is untouched ("Limited" now has a recorded definition).
`CLAUDE.md` SPECKIT block → point at this plan. No constitution change.
