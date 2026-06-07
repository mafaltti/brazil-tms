# Contracts: Collapse Validation Statuses into "Recebida" (slice 015)

No HTTP endpoint is added, removed, or re-shaped. The contracts here are the **status-machine delta**, the
**service signature changes**, the **dispatch board query contract**, and the **i18n/UI surface contract** —
the seams this slice touches. Each reuses existing, already-authorized surfaces. The confirm route/service/
hook and the `import_batch_status` machine are explicitly **out of contract** (unchanged).

## 1. Status machine (shared) — vocabulary + transitions

**Module**: `packages/shared/src/domain/trip-status.ts` (the single source slices import).

```text
TRIP_STATUSES:  remove "validation_error", "validated"   → 16 values
ACTIVE_TRIP_STATUSES: remove the same two               → 10 values
NON_EDITABLE_TRIP_STATUSES: unchanged                    → 6 values

TRANSITIONS:
  received:  ["assigned", "cancelled"]                   // was [validated, validation_error, cancelled]
  assigned:  ["confirmed", "received", "cancelled"]      // received = unassign (was validated)
  (delete the "validation_error" and "validated" rows)
  confirmed … cancelled: UNCHANGED
```

**Contract**:
- `canTransition(from, to)` is computed from `TRANSITIONS`; after the edit, `received → assigned` and
  `assigned → received` are legal, `received → validated|validation_error` and `assigned → validated` are
  not (the targets no longer exist in `TripStatus`).
- `TripStatus = (typeof TRIP_STATUSES)[number]` shrinks to 16 → any `"validated"`/`"validation_error"`
  literal in TS becomes a **compile error** (intended safety net).
- The partition invariant `ACTIVE_TRIP_STATUSES.length + NON_EDITABLE_TRIP_STATUSES.length === TRIP_STATUSES.length`
  (10 + 6 = 16) MUST hold.

## 2. `createTrip` service (db) — REVERT slice 014 (signature contraction)

**Module**: `packages/db/src/trips/trips-service.ts` (exported via `@brazil-tms/db`).

```ts
// BEFORE (slice 014)
export async function createTrip(
  input: CreateTripInput, actorUserId: string,
  initialStatus: InitialTripStatus = "received",
): Promise<TripDetail>

// AFTER (slice 015 — reverted, born received)
export async function createTrip(
  input: CreateTripInput, actorUserId: string,
): Promise<TripDetail>
```

**Contract**:
- Inserts `current_status = "received"` and writes the `trip.create` audit with
  `newValue.currentStatus = "received"` (hardcoded). The `InitialTripStatus` type and the
  received/validated guard are removed.
- `CreateTripInput` / `createTripSchema` unchanged.
- All callers create trips at `received`; no caller passes a status.

**Callers** (post-change):

| Caller | Resulting status |
|--------|------------------|
| `workers/jobs/confirm-import/index.ts` (new / potential_duplicate) — arg dropped | `received` |
| `workers/jobs/confirm-import/index.ts` (update-vanished → create) — arg dropped | `received` |
| `apps/web/lib/imports/manual-create.ts` (manual create) | `received` |
| db/web unit tests | `received` |

## 3. `confirm-import` worker — behavioral contract

**Module**: `workers/jobs/confirm-import/index.ts`. Orchestration unchanged; the only change is dropping the
`"validated"` argument at the two create sites + comment wording.

| Per-row case | Action | Trip status outcome |
|--------------|--------|---------------------|
| `valid`/`warning` + `new`/`potential_duplicate` | `createTrip(input, actor)` | **born `received`** |
| `valid`/`warning` + `update` (trip exists) | `updateTripPlan(existing, …)` | **unchanged** |
| `new` row, unique-key race → existing trip | `updateTripPlan(existing, …)` | **unchanged** |
| `update` row, matched trip vanished | `createTrip(input, actor)` | **born `received`** |
| `no_op` / `error` / unresolved | skip / not applied | n/a |

**Invariants** (covered by tests):
- **I1**: every trip newly created by confirm is `received` and **immediately assignable** (`received → assigned`).
- **I2**: no existing trip's `current_status` is changed by confirm (update/race/no-op are status-neutral) —
  an already-`assigned`/in-execution trip stays as-is.
- **I3**: confirm remains idempotent (the `applied_at` guard + unique index are unchanged).
- **I4 (do not touch)**: `setBatchStatus(batchId, "validated")` is the **`import_batch_status`** enum and
  stays.

## 4. Assignment services (db) — source/target retarget

**Module**: `packages/db/src/trips/trip-assignments.ts`.

```text
assignTrip:    optimistic guard WHERE current_status = 'received'   (was 'validated')
               status_change event statusBefore = 'received' ; audit previousValue.currentStatus = 'received'
unassignTrip:  requires canTransition('assigned','received')        (was 'assigned'→'validated')
               sets current_status = 'received' ; event statusAfter = 'received' ; audit newValue = 'received'
reassignTrip:        UNCHANGED (legal from 'assigned' / 'confirmed')
confirmTripAssignment: UNCHANGED ('assigned' → 'confirmed')
```

**Contract**: assignment runs `received → assigned`; unassignment runs `assigned → received`; the confirm
hop is retained. Optimistic-concurrency `expectedFromStatus` for assign is now `received`.

## 5. BFF assignment route — branch key

**Module**: `apps/web/app/api/trips/[id]/assignment/route.ts` (existing endpoint; auth unchanged).

```text
POST /api/trips/:id/assignment
  expectedFromStatus === 'received'  → assignTrip     (was 'validated')
  else                                → reassignTrip   (assigned/confirmed)
DELETE /api/trips/:id/assignment      → unassignTrip   (assigned → received; doc text updated)
POST /api/trips/:id/assignment/confirm → UNCHANGED (confirmTripAssignment)
```

**Hardening (review follow-up):** the generic `POST /api/trips/:id/status` route (`update_trip_status`,
execution milestones) now REJECTS an assignment-phase `toStatus` ∈ {`received`, `assigned`, `confirmed`}
with `409 USE_ASSIGNMENT_ENDPOINT`. Those states must be entered through the dedicated assignment/confirm
endpoints above, which enforce `assign_resources`, run eligibility, and write the `trip_assignments` row.
This closes a pre-existing gap (the legal table edge `received → assigned` was reachable via the generic
`transitionTripStatus`, minting a structurally inconsistent `assigned` trip with no assignment row and
skipping `assign_resources`). The status machine table is unchanged — the edge stays legal for
`assignTrip`; only this route refuses to perform it.

## 6. Dispatch board query — contract

**Module**: `apps/web/components/trips/dispatch/dispatch-board.tsx` (client constant); consumed by
`GET /api/trips` → `queryTripBoard` → `buildWhere`.

```text
BEFORE:  DISPATCH_QUERY = "assigned=false&status=validated&sort=pickupStart"
AFTER:   DISPATCH_QUERY = "assigned=false&status=received&sort=pickupStart"
```

**Contract** (no endpoint/schema change):
- `status=received` → `query.status = ["received"]` (via `params.getAll` + the `oneOrMany` preprocessor in
  `trip-board.ts`).
- A non-empty `query.status` suppresses the `scope=active` default in `buildWhere`
  (`packages/db/src/trips/trips-read.ts`) and applies `current_status IN ('received')`.
- `assigned=false` → `isNull(currentAssignment)`; composes with AND.
- Net: the queue returns **exactly unassigned `received` trips** — every "Atribuir" succeeds
  (`received → assigned`). `sort=pickupStart` remains whitelisted. Auth unchanged.

## 7. UI surface + i18n contract

**Modules**: `trip-status-badge.tsx`, `assignment-panel.tsx`, `control-tower-table.tsx`,
`assignment-form.tsx` (comments), `messages/pt-BR.json`.

```text
trip-status-badge STATUS_CLASS: remove "validation_error", "validated" keys (Record<TripStatus> typechecks); KEEP "confirmed"
assignment-panel  ASSIGNABLE_STATUSES: {received, assigned, confirmed}
control-tower      quick-assign visible when currentStatus === "received"
pt-BR Trips.status: remove "validation_error" + "validated"; KEEP "received","assigned","confirmed",…
pt-BR Dispatch.unassignConfirmBody: "…a viagem voltará para Recebida…" (was "Validada")
pt-BR Dispatch.confirm / confirming / confirmSuccess / confirmedBy / confirmedAt: UNCHANGED (confirm retained)
```

**Contract**: no operator-visible surface (badge, filter chips, dispatch queue, dialogs, inspector/audit
views) may display "Validada" or "Erro de validação" after this change. Every `currentStatus` rendered has
a `STATUS_CLASS` entry and a pt-BR label (guaranteed by the backfill + the typed `Record<TripStatus>`).

## 8. Out of contract (verified unchanged)

`confirmed` status; `confirmTripAssignment` + `/assignment/confirm` route + `useConfirmAssignment` + the
"Confirmar" button; `confirmAssignmentSchema`; `trip.confirm` audit; `confirmed_by`/`confirmed_at`;
`sla-risk.ts` (`missed_confirmation`, `confirmationCutoffMinutes`, `unconfirmed_within_window`); `sla-sweep`
maps; `trip-plan.ts` review gate; all `confirmed`-onward transitions; the **`import_batch_status`** enum and
every `importBatches.status` reference; the import engine; audit/event semantics; duplicate detection.
