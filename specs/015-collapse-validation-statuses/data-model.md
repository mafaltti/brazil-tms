# Data Model: Collapse Validation Statuses into "Recebida" (slice 015)

**Durable additions: one data-only migration (0008).** No new table, column, enum value, index, permission,
or runtime dependency. The change is to the **active status vocabulary** (16 values), its **transition
table**, the **import-created initial status**, and a **one-time backfill** of existing rows. Every entity
is reused as slices 003/004/006/014 defined it, except that the three active `trip_status`-backed columns
(`trips.current_status`, `trips.disputed_from_status`, `status_mappings.internal_status`) gain a type-only
`.$type<TripStatus>()` pin (no SQL diff) — see §2.

## 1. The trip status machine (the core change)

### `TRIP_STATUSES` — active vocabulary 18 → 16

`packages/shared/src/domain/trip-status.ts` is the single source of truth. Remove `validation_error` and
`validated`:

```text
received, assigned, confirmed, at_origin, loading, loaded, in_transit, at_destination,
unloading, unloaded, completed, billing_pending, billing_ready, billed, cancelled, disputed     (16)
```

### `TRANSITIONS` — two rows rewritten, two rows deleted

| From | Before | After |
|------|--------|-------|
| `received` | `[validated, validation_error, cancelled]` | `[assigned, cancelled]` |
| `validation_error` | `[received]` | **(row deleted)** |
| `validated` | `[assigned, cancelled]` | **(row deleted)** |
| `assigned` | `[confirmed, validated, cancelled]` *(validated = unassign)* | `[confirmed, received, cancelled]` *(received = unassign)* |
| `confirmed` → `cancelled` | unchanged | **unchanged** |

`canTransition` is data-driven — no code-body change. The legal machine is not weakened: removing two
states is a vocabulary reduction, not a transition bypass; transitions out of `received`/`assigned` still
route through the guarded `assignTrip`/`unassignTrip`/`transitionTripStatus`.

### Derived sets

| Set | Before | After |
|-----|--------|-------|
| `ACTIVE_TRIP_STATUSES` | 12 (incl. validation_error, validated) | **10** (those two removed) |
| `NON_EDITABLE_TRIP_STATUSES` | 6 | **6 (unchanged)** |
| Partition invariant | active(12) + nonEditable(6) = 18 | active(10) + nonEditable(6) = **16** ✅ |
| `BILLING_PHASE_STATUSES`, `TRIP_CRITICAL_FIELDS` | — | **unchanged** |

## 2. `trip_status` pgEnum — 18 members, 2 dormant (no DDL)

`packages/db/schema/enums.ts` keeps **all 18** `trip_status` members (Postgres has no `DROP VALUE`;
`trip_events` history must stay immutable). `validation_error` and `validated` become **dormant**:
documented in a comment, removed from the active TS machine, and **unreachable** by any TS-typed writer.

```text
trip_status (DB, 18)  ⊇  TRIP_STATUSES (TS active, 16)        ← intentional, documented divergence
dormant = { validation_error, validated }                    ← members for history only
```

### Drizzle column typing (`packages/db/schema/trips.ts`)

Pin the two `trip_status` columns to the 16-value machine so typecheck reflects the active vocabulary
(type-only; **no generated SQL**):

```ts
import type { TripStatus } from "@brazil-tms/shared";
// ...
currentStatus: tripStatus("current_status").notNull().default("received").$type<TripStatus>(),
disputedFromStatus: tripStatus("disputed_from_status").$type<TripStatus>(),
```

**Five columns are backed by the `trip_status` pgEnum** (not the four originally counted) — `status_mappings.internal_status` is the fifth. Classify each:

| Column | Treatment |
|--------|-----------|
| `trips.current_status`, `trips.disputed_from_status` | **active** — pin `.$type<TripStatus>()` + backfill (§3) |
| `status_mappings.internal_status` | **active config** — pin `.$type<TripStatus>()` + backfill (§3); the upsert path already validates against `TRIP_STATUSES` |
| `trip_events.status_before`, `trip_events.status_after` | **immutable history** — do NOT pin/backfill; widen the *DTO* to the physical 18 via `type TripEventStatus = (typeof tripStatus.enumValues)[number]` in `trip-dto.ts` so historical rows still read/render |

`import_batch_status` (a **separate** enum that also contains `validated`/`confirming`) is **untouched**.

## 3. Migration 0008 — data-only backfill

Scaffold: `drizzle-kit generate --custom --name=collapse_validation_statuses` (appends journal idx 8 +
snapshot, no schema diff). Body:

```sql
-- slice 015: collapse validation statuses into 'received'.
UPDATE "trips" SET "current_status" = 'received'
  WHERE "current_status" IN ('validated', 'validation_error');
UPDATE "trips" SET "disputed_from_status" = 'received'
  WHERE "disputed_from_status" IN ('validated', 'validation_error');
-- the fifth tripStatus-backed column (config target):
UPDATE "status_mappings" SET "internal_status" = 'received'
  WHERE "internal_status" IN ('validated', 'validation_error');
```

- `trip_events.status_before`/`status_after` rows holding the old values are **left intact** (append-only
  immutable history).
- Idempotent (re-running matches nothing after the first apply).
- The pgEnum still contains the literals, so the `UPDATE` needs no type juggling.

## 4. `createTrip` service contract — REVERT slice 014

`packages/db/src/trips/trips-service.ts`:

```text
BEFORE (slice 014):
  createTrip(input, actorUserId, initialStatus: InitialTripStatus = "received")
    └─ insert current_status = initialStatus ; trip.create audit newValue = initialStatus
    └─ guard: initialStatus ∈ { "received", "validated" }

AFTER (slice 015 — reverted):
  createTrip(input, actorUserId)
    └─ insert current_status = "received" ; trip.create audit newValue.currentStatus = "received"
    └─ (no initialStatus param, no InitialTripStatus type, no guard)
```

`CreateTripInput`/`createTripSchema` were never involved (status is a service concern, not file/form data).

## 5. Import-created initial status

| Path | Before (slice 014) | After (slice 015) |
|------|--------------------|-------------------|
| Import `new` / `potential_duplicate` → new trip (`confirm-import` ×2) | `validated` | **`received`** |
| Import `update` → existing trip (`updateTripPlan`) | status untouched | status untouched (unchanged) |
| Import unique-race fallback → `updateTripPlan` | status untouched | status untouched (unchanged) |
| Manual create (`POST /api/trips` → `manual-create.ts`) | `received` | `received` (unchanged) |

A born-`received` trip is **immediately dispatchable** (`received → assigned`), which is the whole point of
the collapse — the slice-014 "stranded before dispatch" problem is solved by making the birth status the
dispatchable one, rather than by advancing past it.

## 6. Dispatch + assignment seams

| Seam | Before | After |
|------|--------|-------|
| `DISPATCH_QUERY` (dispatch-board.tsx) | `assigned=false&status=validated&sort=pickupStart` | `assigned=false&status=received&sort=pickupStart` |
| `assignTrip` source guard | `WHERE current_status = 'validated'` | `WHERE current_status = 'received'` |
| `assignTrip` event/audit `statusBefore`/`previousValue` | `validated` | `received` |
| `unassignTrip` target + legality | `assigned → validated` | `assigned → received` |
| BFF assign branch key (`assignment/route.ts`) | `expectedFromStatus === 'validated'` | `=== 'received'` |
| `ASSIGNABLE_STATUSES` (assignment-panel) | `{validated, assigned, confirmed}` | `{received, assigned, confirmed}` |
| control-tower quick-assign gate | `currentStatus === 'validated'` | `=== 'received'` |
| `reassignTrip`, `confirmTripAssignment` | — | **unchanged** (keyed on assigned/confirmed) |

## 7. Reused, unchanged entities

- **`trip_events` / `audit_logs`** — append-only; not rewritten. Historical `validated`/`validation_error`
  status-change rows remain valid (the pgEnum still lists the literals). The `trip.create` audit now
  records `received` for imports (auto, via the reverted `createTrip`).
- **`trip_assignments`** (`confirmed_by`/`confirmed_at`) — unchanged; the confirm flow is retained.
- **`import_batches` / `import_rows`** — unchanged; the batch lifecycle (`received → parsing → validating →
  validated → confirming → completed`) and per-row `outcome` are untouched. Confirm still applies only
  `valid`/`warning` rows.
- **SLA** (`sla-risk.ts`, `customer_sla_rules.confirmation_cutoff_minutes`, `sla-sweep`) — unchanged;
  `confirmed` and `confirmed_at` still drive `missed_confirmation`/`unconfirmed_within_window`.

## 8. State / flow delta (summary)

```text
Import confirm (per applied valid/warning row):
  new | potential_duplicate ──► createTrip(input, actor)            ◄── born "received" (was "validated")
  update | unique-race ────────► updateTripPlan(existing, …)         (status UNCHANGED)

Lifecycle (active machine, 16):
  received ──assign──► assigned ──confirm──► confirmed ──► at_origin ──► … ──► billed   (+ cancelled, disputed)
     ▲                    │
     └──── unassign ◄─────┘   (assigned → received; was assigned → validated)

Dispatch queue read:
  "assigned=false & status=received & sort=pickupStart"
     └─ buildWhere: isNull(assignment) AND current_status IN ("received")   → only unassigned, assignable

Backfill (one-time, 0008):
  trips.current_status / disputed_from_status  ∈ {validated, validation_error} ──► "received"
  trip_events history ──► left intact (immutable)
```
