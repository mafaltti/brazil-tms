# Research: Auto-Validate Imported Trips (slice 014)

The core design question was resolved in the spec's **Clarifications** session (2026-06-07: born
`validated` atomically). This file consolidates each decision with its rationale and the alternatives
weighed, plus the code-grounded findings that shape the plan. No `NEEDS CLARIFICATION` remain.

## R1 — How a newly imported trip reaches `validated`: born validated (atomic)

- **Decision**: Extend the promoted `createTrip` service with an **optional `initialStatus`** parameter
  (default `"received"`). The trip is inserted **directly in `validated`** within `createTrip`'s single
  transaction; there is no separate `received → validated` transition and no raw post-create status write.
- **Rationale**: The slice exists to stop trips being stranded in `received`. Born-validated is atomic, so
  no worker crash between creation and validation can re-strand a trip. Verified safe across crash/re-run
  orderings: a confirm re-run either skips an already-applied row, or (on a unique-key race) re-resolves a
  `new` row to `updateTripPlan`, which by design does **not** change status — and the trip is already
  `validated`, so it stays correct. `createTrip` already writes the `trip.create` audit with
  `newValue.currentStatus`, so the audit records `validated` automatically with no extra write.
- **Alternatives**: (a) **Create-then-transition** via `transitionTripStatus(received → validated)` — uses
  two transactions (it opens its own), leaving a crash window where an applied trip sits in `received` that
  a re-run would never recover (re-run skips applied rows). Reintroduces the bug; would need extra recovery
  logic. (b) **Raw status `UPDATE`** after create — rejected by Constitution III (no ad-hoc/unaudited status
  writes). (c) An `initialStatus` field on `createTripSchema`/`CreateTripInput` — rejected: status is not
  file-derived data; it belongs as a **function parameter**, not in the parsed input schema.

## R2 — Exact `createTrip` signature change + caller safety (finding)

- **Decision**: `createTrip(input: CreateTripInput, actorUserId: string, initialStatus: TripStatus = "received")`
  — `initialStatus` is the **3rd** positional param (after `actorUserId`) so existing positional callers
  are unaffected. In the body, replace the hardcoded `currentStatus: "received"` at **both** the insert
  (`trips-service.ts:63`) and the `trip.create` audit `newValue` (`:85`) with `initialStatus`.
- **Rationale**: Grounded in a full caller census. `createTrip` has **11 callers**; only the two in
  `confirm-import` (`index.ts:149`, `:171`) should pass `"validated"`. Every other caller — `manual-create.ts:64`
  (operator manual create, kept `received`), plus 9 db/web unit tests — relies on the default and is
  unchanged. `CreateTripInput` (`packages/shared/src/schemas/trip.ts`) has **no** `currentStatus` field,
  confirming status belongs as a function param. The seed `trip-domain-sample.ts:92` does a raw
  `db.insert(trips)` (not via `createTrip`), so it is unaffected.
- **Alternatives**: Inserting `initialStatus` as the 2nd param (before `actorUserId`) — rejected: it would
  shift every positional call and risk silent arg-order bugs.

## R3 — Only the two create paths validate; update paths must not (finding)

- **Decision**: In `confirm-import`, pass `"validated"` **only** at the two `createTrip` sites
  (`index.ts:149` for `new`/`potential_duplicate`; `:171` for an `update` whose matched trip vanished →
  create). Leave the `updateTripPlan` paths (`:156` race-fallback, `:167` `update`) and the `no_op` path
  **unchanged** — they touch existing trips and must preserve status.
- **Rationale**: An `update` row may target a trip already `assigned`/`confirmed`/`in_transit`; resetting it
  to `validated` would silently unwind dispatch/execution work (spec US2 / FR-002). Because validation is
  bound to `createTrip` (which only ever produces a brand-new trip), the update/race/no-op paths are
  structurally incapable of changing status — the guarantee holds by construction, not by a runtime guard.
- **Alternatives**: A post-hoc `transitionTripStatus` keyed on match decision — more code and a status-write
  on a path that must stay status-neutral; rejected.

## R4 — Idempotency / crash-recovery is preserved (finding)

- **Decision**: No change to the confirm idempotency model. The existing `appliedAt` guard + the
  `(customer_id, external_trip_id)` partial-unique index remain the idempotency backstops.
- **Rationale**: Born-validated rides inside the **same** `createTrip` transaction, so the trip's status and
  its existence commit together — a re-run sees an already-created `validated` trip (via the unique index →
  re-resolved as a status-neutral `updateTripPlan`) or an already-applied row (skipped). There is no state
  in which an applied trip is left at `received`. This is the decisive advantage over create-then-transition
  (R1 alt a).

## R5 — Dispatch queue narrowing: exact query string (finding)

- **Decision**: Change `dispatch-board.tsx:30` `DISPATCH_QUERY` from
  `"assigned=false&scope=active&sort=pickupStart"` to **`"assigned=false&status=validated&sort=pickupStart"`**.
- **Rationale**: Grounded in the board read path. The board query parser reads `status` via
  `params.getAll("status")` through the `oneOrMany` preprocessor (`packages/shared/src/schemas/trip-board.ts`),
  so a single `status=validated` becomes `["validated"]`. In `buildWhere` (`trips-read.ts`), a non-empty
  `query.status` (a) applies `inArray(current_status, ["validated"])` and (b) **suppresses** the
  `scope=active` default (the default fires only when `!query.status?.length`), so `scope=active` is removed.
  `assigned=false` applies `isNull(boardAsg.id)` and composes with AND → exactly *unassigned validated*
  trips. `sort=pickupStart` is in the sort whitelist and stays valid. The client passes the raw query string
  straight to `GET /api/trips?…` (`client.ts`), and the route parses it with `tripBoardQueryFromParams` — no
  endpoint or schema change needed.
- **Alternatives**: Keeping `scope=active` and adding `status=validated` — harmless (status suppresses
  scope) but misleading; omit `scope=active` for clarity. Adding a server-side "assignable" flag — needless
  new surface; the status filter already exists.

## R6 — Manual trip-create and a "Validar" UI stay out of scope (finding)

- **Decision**: Do **not** auto-validate the manual trip-create path (`POST /api/trips` →
  `createOrUpdateTripManually` → `createTrip` with the default `received`), and do **not** add any operator
  "Validar" action.
- **Rationale**: The slice scope is the **import → dispatch** flow. Manual create is a separate, low-traffic
  path; leaving it at `received` is consistent with spec §Out of Scope ("wiring received→validated anywhere
  else in the UI"). The `createTrip` default (`received`) means manual-create needs **zero** change. A
  manual `received` trip without a validate UI is a known, accepted limitation tracked as future work.
- **Alternatives**: Born-validate manual creates too — expands scope and would strand the decision about
  whether human-entered trips should skip review; deferred.

## R7 — Test impact: one assertion flips; transition/dispatch suites stay (finding)

- **Decision**: Edit one assertion (`confirm.test.ts:167` `received → validated`, rename its test); add
  born-validated coverage (US1/US2/US3); leave the transition machine, manual-create, batch-status, and all
  dispatch-e2e suites unchanged.
- **Rationale**: Census of every `"received"` assertion: only `confirm.test.ts:167` asserts a *created
  trip's* initial status from import. `manual-create.test.ts:90` and `trips-service.test.ts:96` assert the
  **default** path (unchanged → stay `received`). `import-batches-service.test.ts:130` asserts
  `import_batches.status` (batch lifecycle, not trip status) → unchanged. `trip-transitions.test.ts` and the
  execution/timeline e2e exercise the *legal transition table* (`received → validated → …`), which this slice
  does not alter (only the import entry point moves). **All** dispatch e2e (`dispatch-board/-assignment/-authz/
  -override/-reassign/-warnings.spec.ts`) already seed `currentStatus:"validated"`, so they need no status
  edits. `messages.test.ts` needs none (no new i18n keys). New coverage: confirm-created trip is `validated`
  and assignable (US1); an `update` to an already-`assigned` trip keeps `assigned` (US2); the Expedição queue
  excludes a `received` trip (US3).

## R8 — No migration; net-zero durable change (finding)

- **Decision**: Ship no migration. Reuse the existing `validated` value of the `trip_status` enum.
- **Rationale**: The status value, the `received → validated` edge, the `trip_event_source` enum, and all
  indexes already exist. Born-validated changes only which value `createTrip` inserts for the import path —
  a code change, not a schema change.
