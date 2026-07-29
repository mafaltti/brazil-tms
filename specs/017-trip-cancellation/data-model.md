# Data Model — Trip Cancellation in Control Tower and Dispatch (017)

**Date**: 2026-07-27 · **Spec**: [spec.md](./spec.md) · **Research**: [research.md](./research.md)

**No schema change. No migration.** Every durable structure this slice touches shipped in 003;
this slice populates them through a new exposure path and adds seed **rows** only.

## 1. Existing structures used as-is

### `trips` cancellation fields (`packages/db/schema/trips.ts`)

| Column | Type | Written by this slice via `cancelTrip` |
|---|---|---|
| `current_status` | `trip_status` pgEnum (pinned to 16-value `TripStatus`) | → `'cancelled'` (status-guarded update) |
| `cancellation_reason_code` | text | validated against active `cancellation_options` (`kind='reason'`) |
| `cancellation_responsible_party` | `cancellation_responsible_party` pgEnum (4 values) | from the dialog |
| `cancellation_billing_impact` | text | validated against active `cancellation_options` (`kind='billing_impact'`) |
| `cancelled_at` | timestamptz | server `now()` — client-supplied timestamps are ignored (FR-005) |

### `cancellation_options` (config, `packages/db/schema/cancellation-options.ts`)

`(id, kind ∈ {reason, billing_impact}, code, label_pt, active, sort_order, …)`, unique `(kind, code)`.
Read by the new `GET /api/cancellation-options` (active rows, both kinds, ordered by `sort_order`).

### `trip_events` / `audit_logs`

Unchanged — `cancelTrip` already appends the `status_change` event (with `event_timestamp =
cancelled_at`) and the `trip.cancel` audit row (previous status + all §19.5 inputs). The audit
action `trip.cancel` and its pt-BR label (`AuditActions.trip_cancel`) already exist.

## 2. Domain vocabulary delta (`packages/shared`)

- **NEW** `DISPATCH_PHASE_TRIP_STATUSES = ["received", "assigned", "confirmed"] as const`
  (`domain/trip-status.ts`) — the named §18 "Dispatcher Limited" boundary (clarification
  2026-07-27). Used by the cancel route guard and the UI visibility rule.
- **EXTENDED** `cancelTrip` signature: optional `opts?: { allowedSourceStatuses?: readonly TripStatus[] }`
  → `Conflict("NOT_CANCELLABLE_BY_ROLE")` when the loaded `current_status` is outside the list.
  Race-safe via the existing optimistic `WHERE current_status = <checked>` update.
- `cancelTripSchema` unchanged (reasonCode, responsibleParty, billingImpact, optional timestamp —
  the BFF never forwards the timestamp).

## 3. Seed rows (config data, not schema)

`packages/db/seed/trip-domain-sample.ts` — `reason` kind, idempotent per `(kind, code)` (same
mechanism as the shipped `billing_impact` block):

| code | label_pt | sort |
|---|---|---|
| `cancelled_by_customer` | Cancelado pelo cliente | 1 |
| `no_vehicle_available` | Sem veículo disponível | 2 |
| `no_driver_available` | Sem motorista disponível | 3 |
| `weather_road` | Clima/estrada | 4 |
| `documentation_issue` | Problema de documentação | 5 |
| `other` | Outro | 6 |

`billing_impact` rows (`no_charge`, `cancellation_fee`, `manual_review`) are already seeded by 003.
Both lists remain config: business sign-off pending (FR-013), admins may edit rows freely.

## 4. Read model

`GET /api/cancellation-options` → `{ items: Array<{ kind: "reason" | "billing_impact", code: string,
labelPt: string, sortOrder: number }> }` — active rows only, ordered `kind, sort_order`. No pagination
(bounded config list). Permission: `cancel_trip`.
