# Data Model — 010 Trip Validation Action & Dispatch Queue Hardening

**Delta: NONE.** This corrective slice adds **no** table, column, enum, index, or migration. It only **exercises already-legal transitions** in the existing `trip_status` machine and **reuses** the append-only history/audit writes that slice 003's `transitionTripStatus` already performs. This document records *what existing model elements are touched* and the invariants the slice must preserve — there is nothing new to create.

## Entities touched (all pre-existing — no schema change)

### Trip (`trips`)

- Reused unchanged. The slice moves a trip along **already-declared** legal edges; `createTrip` still defaults `current_status = 'received'` (unchanged).
- No new column. The "is this trip ready to assign?" question is answered by `current_status` (`= 'validated'`), not a new flag.

### Trip Event (`trip_events`) — append-only

- Reused unchanged. Each validate/correction produces one `status_change` event written **inside `transitionTripStatus`'s transaction** (`statusBefore`, `statusAfter`, `source`, `actorUserId`). Append-only REVOKE enforcement (slice 001/003) is unaffected.

### Audit Log (`audit_logs`) — append-only

- Reused unchanged. Each validate/correction produces one `trip.status_change` audit record (`previousValue`/`newValue`/`actorUserId`) in the same transaction. No new `AuditAction`.

### Trip Assignment (`trip_assignments`)

- Reused unchanged. The slice does **not** touch assignment rows; it only changes (a) **which trips are offered** for assignment (the board query) and (b) **how a non-assignable attempt is reported** (the `NOT_ASSIGNABLE` conflict). `assignTrip`/`reassignTrip`/the partial-unique current-assignment index are untouched.

## Status transitions exercised (all already legal — `packages/shared/src/domain/trip-status.ts`)

| From | To | Edge already legal? | Trigger added by this slice | Service (existing) |
|------|----|---------------------|-----------------------------|--------------------|
| `received` | `validated` | ✅ (`received: ["validated", "validation_error", "cancelled"]`, line 85) | **Validate action** (Trip Detail) | `transitionTripStatus` via `POST /status` |
| `validation_error` | `received` | ✅ (legal edge) | **Correction action** (Trip Detail) | `transitionTripStatus` via `POST /status` |
| `validated` | `assigned` | ✅ (driven by 006) | (unchanged) — now reachable end-to-end because trips can reach `validated` | `assignTrip` via `POST /assignment` |

The status machine table is the **single source of truth** and is **not modified** (Constitution III). `canTransition` already permits all three edges; the slice adds only the **UI triggers** for the first two and makes the third reachable through the product.

## Invariants the slice MUST preserve

- **INV-1 (single write path)**: every status change — including validate — flows through `transitionTripStatus`; **no raw `UPDATE current_status`** anywhere (including the seed). *(Constitution III)*
- **INV-2 (optimistic concurrency)**: the validate transition is guarded by the existing `WHERE current_status = expectedFromStatus` pin (→ `STALE_TRANSITION` on a stale submit); concurrent validates do not double-apply.
- **INV-3 (append-only history)**: each validate writes exactly one `trip_events` row + one `audit_logs` row, atomically; nothing is mutated or deleted.
- **INV-4 (authorization at the BFF)**: validate requires `update_trip_status`; assignment requires `assign_resources` — both enforced server-side, never the UI.
- **INV-5 (no durable additions)**: a schema diff after this slice shows **zero** new tables/columns/enums/indexes/migrations. *(Constitution I)*
- **INV-6 (queue truthfulness)**: the dispatch queue contains only trips that `assignTrip` can act on (`validated`, unassigned) — verifiable by asserting every queued row assigns without a status error.

## Migration

**None.** No `drizzle` migration is generated. (The research R10 contingency — a supporting index — is explicitly not needed: the hardened query is narrower than the current `scope=active` query and uses existing indexes.)
