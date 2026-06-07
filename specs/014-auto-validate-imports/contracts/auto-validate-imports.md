# Contracts: Auto-Validate Imported Trips (slice 014)

No HTTP endpoint is added or changed. The "contracts" here are the **internal service signature delta**,
the **confirm-import behavioral contract**, and the **dispatch board query contract** — the three seams
this slice touches. Each reuses existing, already-authorized surfaces.

## 1. `createTrip` service (db) — backward-compatible signature extension

**Module**: `packages/db/src/trips/trips-service.ts` (exported via `@brazil-tms/db`).

```ts
// BEFORE
export async function createTrip(
  input: CreateTripInput,
  actorUserId: string,
): Promise<TripDetail>

// AFTER  (additive, backward-compatible)
export async function createTrip(
  input: CreateTripInput,
  actorUserId: string,
  initialStatus: TripStatus = "received",   // NEW — defaults preserve every existing caller
): Promise<TripDetail>
```

**Contract**:
- When `initialStatus` is omitted ⇒ identical behavior to today (trip created `received`).
- The trip is `INSERT`ed with `current_status = initialStatus` **inside the existing single
  transaction**, together with the `trip.create` audit whose `newValue.currentStatus = initialStatus`.
- `initialStatus` MUST be a legal `trip_status` enum value. Callers only ever pass `"received"` (default)
  or `"validated"` (confirm-import). No transition-legality check applies (this is an *initial* status,
  not a transition).
- `CreateTripInput` / `createTripSchema` are **unchanged** — `initialStatus` is a function argument, not
  parsed input.

**Callers** (post-change):

| Caller | `initialStatus` passed | Resulting status |
|--------|------------------------|------------------|
| `workers/jobs/confirm-import/index.ts:149` (new / potential_duplicate) | `"validated"` | `validated` |
| `workers/jobs/confirm-import/index.ts:171` (update-vanished → create) | `"validated"` | `validated` |
| `apps/web/lib/imports/manual-create.ts:64` (manual create) | _(omitted)_ | `received` |
| 9 db/web unit tests | _(omitted)_ | `received` |

## 2. `confirm-import` worker — behavioral contract

**Module**: `workers/jobs/confirm-import/index.ts`. Unchanged orchestration; the only change is the
`initialStatus` argument at the two create sites and the header comment.

| Per-row case | Action | Trip status outcome |
|--------------|--------|---------------------|
| `valid`/`warning` + `match_decision ∈ {new, potential_duplicate}` | `createTrip(input, actor, "validated")` | **born `validated`** |
| `valid`/`warning` + `match_decision = update` (trip exists) | `updateTripPlan(existing, …)` | **unchanged** (keeps current status) |
| `new` row, unique-key race → existing trip found | `updateTripPlan(existing, …)` | **unchanged** |
| `update` row, matched trip vanished | `createTrip(input, actor, "validated")` | **born `validated`** |
| `no_op` | skip apply | n/a |
| `error` / unresolved | not applied | n/a (no trip) |

**Invariants** (must hold; covered by tests):
- **I1**: every trip newly created by confirm is `validated` (immediately assignable).
- **I2**: no existing trip's `current_status` is ever changed by confirm (update/race/no-op paths are
  status-neutral) — an already-`assigned`/`in_transit` trip stays as-is.
- **I3**: confirm remains idempotent — a re-run creates no duplicate trip and performs no status change
  on already-applied trips (the `appliedAt` guard + unique index are unchanged).

## 3. Dispatch board query — contract

**Module**: `apps/web/components/trips/dispatch/dispatch-board.tsx` (client constant); consumed by the
existing `GET /api/trips` board read (`apps/web/app/api/trips/route.ts` → `queryTripBoard`).

```text
BEFORE:  DISPATCH_QUERY = "assigned=false&scope=active&sort=pickupStart"
AFTER:   DISPATCH_QUERY = "assigned=false&status=validated&sort=pickupStart"
```

**Contract** (no endpoint/schema change — reuses the existing board query parser):
- `status=validated` → `query.status = ["validated"]` (via `params.getAll("status")` + the `oneOrMany`
  preprocessor in `packages/shared/src/schemas/trip-board.ts`).
- A non-empty `query.status` **suppresses** the `scope=active` default in `buildWhere`
  (`packages/db/src/trips/trips-read.ts`) and applies `current_status IN ("validated")`.
- `assigned=false` → `isNull(currentAssignment)`; composes with AND.
- Net: the queue returns **exactly unassigned `validated` trips** — every "Atribuir" it offers can
  succeed (`validated → assigned`). `sort=pickupStart` remains a whitelisted sort.

**Authorization**: unchanged — the board read enforces its existing auth; no new permission key.
