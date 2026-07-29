# Data Model: Auto-Validate Imported Trips (slice 014)

**This slice adds NOTHING durable** — no new table, column, enum value, index, or migration. The only
change is **which existing `trip_status` value a newly imported trip is created with**: `validated`
instead of `received`. Every entity is reused exactly as slices 003/004/006 defined them.

## Changed behavior: the import status entry point

### `trips.current_status` (existing enum, unchanged membership)

The 18-value `trip_status` machine is unchanged (`packages/shared/src/domain/trip-status.ts`;
`packages/db/schema/enums.ts`). Only the **insert-time initial value for import-created trips** moves:

| Path | Before (slices 004/013) | After (slice 014) |
|------|-------------------------|-------------------|
| Import `new` / `potential_duplicate` row → new trip | `received` | **`validated`** |
| Import `update` row → existing trip (`updateTripPlan`) | status untouched | status untouched (unchanged) |
| Import unique-race fallback → `updateTripPlan` on existing trip | status untouched | status untouched (unchanged) |
| Import `no_op` / `error` / unresolved row | no trip created / no change | no trip created / no change (unchanged) |
| Manual create (`POST /api/trips`) | `received` | `received` (unchanged — out of scope) |

The legal-transition table (`TRANSITIONS`) is **not** modified. Born-validated is an *initial* status at
`INSERT`, not a transition, so it does not bypass or weaken `canTransition`. Transitions **out** of
`validated` (`→ assigned`, `→ cancelled`) still go through the guarded `transitionTripStatus`.

## Service contract delta (the only code "model" change)

### `createTrip` (`packages/db/src/trips/trips-service.ts`)

```text
BEFORE:  createTrip(input: CreateTripInput, actorUserId: string): Promise<TripDetail>
           └─ inserts trips.current_status = "received"   (hardcoded, line 63)
           └─ writes trip.create audit newValue.currentStatus = "received"  (hardcoded, line 85)

AFTER:   createTrip(input: CreateTripInput, actorUserId: string,
                     initialStatus: TripStatus = "received"): Promise<TripDetail>
           └─ inserts trips.current_status = initialStatus
           └─ writes trip.create audit newValue.currentStatus = initialStatus   (auto-captured)
```

- `initialStatus` is a **function parameter**, NOT a field on `CreateTripInput` / `createTripSchema`
  (status is not file/operator-form data).
- **Default `"received"`** ⇒ all 11 existing callers behave identically; only `confirm-import` overrides it.
- The `trip.create` **audit** already records `newValue.currentStatus`, so a born-`validated` trip's
  creation is fully auditable with no extra write (System-of-Record III).

## Reused, unchanged entities

### `import_batches` / `import_rows`
- Schemas and lifecycles unchanged. `import_batches.status` still flows
  `received → parsing → validating → validated → confirming → completed`/`failed`. Per-row
  `outcome ∈ {valid, warning, error}`, `match_decision`, structured `reasons[]`, `applied_at`, and
  `target_trip_id` are all unchanged. Confirm still applies only `valid`/`warning` rows; born-validated
  rides inside the same `createTrip` transaction the row already triggered.

### `trip_events` / `audit_logs`
- Unchanged and untouched. Born-validated produces **no** `status_change` `trip_event` (the trip is never
  in `received`); provenance is the existing `trip.create` audit (now recording `validated`) plus the
  trip's `import_batch_id` link and the batch-level `import.confirm` audit. The append-only history
  guarantees are unaffected.

### `trip_event_source` enum
- Already has `system | operator_manual | import` (`enums.ts:110-114`). Not used by this slice (born-validated
  writes no `trip_event`), but noted: any *future* non-import `received → validated` transition would carry
  its own source via `transitionTripStatus`.

## State / flow delta (summary)

```text
Import confirm (per applied valid/warning row):

  match_decision = new | potential_duplicate ──► createTrip(input, actor, "validated")  ◄── NEW (was "received")
                                                   └─ trip born VALIDATED, atomically, in one tx
                                                   └─ trip.create audit records "validated"

  match_decision = update ───────────────────────► updateTripPlan(existing, …)  (status UNCHANGED)
  unique-race on a `new` row ─────────────────────► updateTripPlan(existing, …)  (status UNCHANGED)
  match_decision = no_op ─────────────────────────► (skip)

Dispatch board queue read:
  "assigned=false & status=validated & sort=pickupStart"  ◄── NEW (was scope=active)
     └─ buildWhere: isNull(assignment) AND current_status IN ("validated")   → only assignable trips
```

No durable additions. No migration.
