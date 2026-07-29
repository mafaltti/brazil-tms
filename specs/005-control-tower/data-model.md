# Phase 1 Data Model: Control Tower, Trip List, Trip Detail, and Daily Dashboard

**Feature**: 005-control-tower | **Spec**: [spec.md](./spec.md) · **Research**: [research.md](./research.md)

Conventions inherited from 001–004: `public` schema, `snake_case`, UUID PKs via `gen_random_uuid()`, `timestamptz` UTC stored / `America/Sao_Paulo` displayed, money as integer centavos BRL, soft-delete via nullable `archived_at`, append-only audit. DDL below is a **design sketch**; the authoritative migration is the `drizzle-kit generate` output. **005 introduces NO new tables and NO new enums** — it is a read/operating surface over the existing trip domain plus one read-supporting index, read models (BFF queries), one shared domain helper, and Zod input schemas. The single write reuses 003's `updateTripPlan` (no schema change).

## Enums

**None.** 005 adds no enum. It reuses `trip_status` (18 values), `vehicle_type`, `cancellation_responsible_party`, `trip_event_type`, and `trip_event_source` from 002/003 (`packages/db/schema/enums.ts`), and the `BillingStatus` projection type from `@brazil-tms/shared`.

## Schema changes

### New index (extend `packages/db/schema/trips.ts`)

```sql
-- Backs date-range filters, "Today"/"Next 24h" views, active-trip ordering by pickup,
-- and the "trips today by status" dashboard counts (R5).
CREATE INDEX trips_pickup_start_idx ON public.trips (planned_pickup_window_start);
```

Existing indexes reused as-is: `trips_customer_idx`, `trips_status_idx`, `trips_created_idx`, `trips_customer_external_id_uq`. No other table is altered.

> **Deferred (NOT added — R5)**: composite `(current_status, planned_pickup_window_start)` and any partial indexes — introduced only if profiling at real volume shows a need (Constitution I, YAGNI).

## Reused tables (read-only consumption — R0, R10)

005 reads, and never alters the shape of, these existing tables:

- **`public.trips`** (003) — the row behind every list/detail/dashboard/export record. The board reads `customer_id`, `external_trip_id`, `origin_location_id`, `destination_location_id`, `lane_id`, `current_status`, `sla_status` (007 placeholder), `planned_pickup_window_start/end`, `planned_delivery_window_start/end`, `planned_vehicle_type`, plus `original_plan` and the cancellation fields for detail. `billing_status` is **derived**, never stored (see Projections).
- **`public.trip_events`** (003) — the Trip Detail **Timeline** (read-only) and the actual milestone timestamps; `loadTripDetail` returns the latest 50, newest first.
- **`public.audit_logs`** (001/003) — the Trip Detail **Audit history** (read-only) for `entity_type='trip', entity_id=:id`; the plan edit appends `trip.plan_update` via 003 (no new action).
- **`public.customers`, `public.locations`, `public.lanes`** (002) — joined into the board/detail read models for **display names** and as filter sources.

The only write is 003's `updateTripPlan` → `trips` (live `planned_*`) + `audit_logs` (`trip.plan_update`); the immutable `original_plan` is never rewritten.

## Read models (BFF — `packages/db/src/trips/trips-read.ts`, re-exported server-only)

Read models are Drizzle queries returning DTOs; they are **not** tables. Names are illustrative.

### `queryTripBoard(filters, sort, page) → { rows: TripBoardRow[]; total: number }`  (R2, R3)

- **Joins**: `trips` ⋈ `customers` (name/code), ⋈ origin/destination `locations` (name/code), ⋈ `lanes` (label, nullable).
- **Filters** (composed `AND`, all optional): `customerId`; `status` (one-or-many `current_status`); `billingStatus` → expands to `current_status IN {billing_pending, billing_ready, billed, disputed}` (R3, no stored column); `originLocationId`; `destinationLocationId`; `laneId`; `vehicleType`; `pickupFrom` / `pickupTo` (UTC instants from BRT day math, R6); `q` (ILIKE on `external_trip_id`, customer name, lane label); `scope` (`active` default → `current_status IN ACTIVE_TRIP_STATUSES`, R4).
- **Sort**: whitelist (`pickupStart` default, `customer`, `status`, `createdAt`, `updatedAt`) × `asc|desc`.
- **Page**: `limit` (default 50, max 200) + `offset`; `total` is a parallel `count(*)` over the same `where`.

```text
TripBoardRow = {
  id; externalTripId; customerId; customerName;
  originCode; originName; destinationCode; destinationName; laneLabel | null;
  currentStatus; billingStatus;            // billingStatus = projection (derived)
  slaStatus | null;                        // 007 placeholder, shown read-only
  plannedPickupWindowStart | null; plannedPickupWindowEnd | null;
  plannedDeliveryWindowStart | null; plannedDeliveryWindowEnd | null;
  plannedVehicleType | null; updatedAt;
}
```

> **Not selected (R3/R15)**: assigned driver/vehicle/carrier (006) and any computed SLA-risk class (007) — those columns/joins are added by their owning slices; 005 leaves the row extensible but does not fabricate them.

### `getTripDetailView(id) → TripDetailView | null`  (R10)

Wraps 003's `loadTripDetail(id)` (trip + latest 50 `trip_events` + latest 50 trip `audit_logs`) and adds display-name enrichment (customer, origin/destination, lane) + the `import_batch_id` reference. Returns `null` → route maps to `404`.

```text
TripDetailView = TripDetail (from 003)               // originalPlan, planned_*, cancellation_*, events[], audit[]
  + customerName, originName/originCode, destinationName/destinationCode, laneLabel|null
  + importBatchId|null
  // billingStatus derived; assignment/exceptions/documents/billing detail = NOT included (placeholder sections, 006/007/008)
```

### `queryDashboardMetrics() → DashboardSummary`  (R12)

```text
DashboardSummary = {
  tripsTodayByStatus: { status: TripStatus; count: number }[];   // computed (pickup today, BRT)
  billingPendingCount: number;                                   // computed (current_status = billing_pending)
  tripsAtRisk: null;            // 007
  unassignedTrips: null;        // 006
  activeExceptions: null;       // 007
  onTimePickupPct: null;        // 007
  onTimeArrivalPct: null;       // 007
  completedMissingDocuments: null; // 008
}
```

`null` ⇒ the widget renders a labelled "not yet available" placeholder (Constitution II — no invented values).

### `exportTripRows(filters, cap) → TripBoardRow[]`  (R13)

Same `where`/sort as `queryTripBoard` (no pagination); throws `Conflict('EXPORT_TOO_LARGE')` when the matching `count` exceeds `cap` (default **10,000**) so the handler can return `422` (no silent truncation).

## Shared domain helpers (extend `packages/shared/src/domain/trip-status.ts`)

```typescript
// Active/open operating set — non-terminal statuses (R4). Order matches TRIP_STATUSES.
export const ACTIVE_TRIP_STATUSES = [
  "received", "validation_error", "validated", "assigned", "confirmed",
  "at_origin", "loading", "loaded", "in_transit", "at_destination", "unloading", "unloaded",
] as const satisfies readonly TripStatus[];

export function isActiveStatus(s: TripStatus): boolean;          // s ∈ ACTIVE_TRIP_STATUSES

// Billing-status filter → the concrete statuses to match (no stored column, R3).
// billing_pending|billing_ready|billed|disputed → [self]; null/other → [] (no rows).
export function billingStatusToStatuses(b: BillingStatus): readonly TripStatus[];

// Statuses at/after completion where operational-field editing is blocked (R11, TRIP-005).
export const NON_EDITABLE_TRIP_STATUSES = [
  "completed", "billing_pending", "billing_ready", "billed", "cancelled", "disputed",
] as const satisfies readonly TripStatus[];
```

`billingStatus(s)` (the projection) and `TRIP_STATUSES`, `TRIP_CRITICAL_FIELDS`, `PLAN_FIELDS` are reused from 003 — not redefined.

## Audit actions

**None new.** Operational-field edits reuse 003's `trip.plan_update`. Reads, exports, and dashboard views are **not** audited (not in Constitution IV's audited-action list; YAGNI for MVP — revisit if export auditing is later required).

## Validation rules (Zod — `packages/shared/src/schemas/trip-board.ts`)

- **`tripBoardQuerySchema`** (parses URL params **and** the BFF query — one source of truth, R8): optional `customerId` (uuid), `status` (one-or-many `trip_status`), `billingStatus` (`billing_pending|billing_ready|billed|disputed`), `originLocationId`/`destinationLocationId`/`laneId` (uuid), `vehicleType` (`vehicle_type`), `pickupFrom`/`pickupTo` (ISO date, BRT), `q` (trimmed string), `scope` (`active|all`, default `active`), `sort` (enum whitelist, default `pickupStart`), `dir` (`asc|desc`, default `asc`), `limit` (1–200, default 50), `offset` (≥0, default 0). Unknown sort/filter ⇒ `400 VALIDATION`.
- **`tripExportQuerySchema`**: `tripBoardQuerySchema` without `limit`/`offset` (cap enforced server-side at 10,000 → `422 EXPORT_TOO_LARGE`).
- **`updateTripPlanSchema`**: partial of the 10 live `PLAN_FIELDS` (`plannedPickupWindowStart/End`, `plannedDeliveryWindowStart/End`, `plannedVehicleType`, `plannedVolumeUnits`, `plannedWeightKg`, `plannedPalletCount`, `plannedRouteNotes`, `plannedServiceRequirements`) + optional `authorizedReview: boolean`; **≥1 field required**; pickup/delivery window start ≤ end. The route additionally rejects edits when `current_status ∈ NON_EDITABLE_TRIP_STATUSES` (`409 EDIT_NOT_ALLOWED`, R11) and surfaces 003's `409 REVIEW_REQUIRED` / `409 STALE_TRANSITION`.

## Relationships

- All read models join the existing FK graph only: `trips.customer_id→customers`, `trips.origin_location_id/destination_location_id→locations`, `trips.lane_id→lanes`, `trip_events.trip_id→trips`, `audit_logs(entity_type='trip', entity_id=trips.id)`.
- **No new FK, no new table, no new enum.** The only schema delta is `trips_pickup_start_idx`.
- Forward hooks left for later slices (R15): assignment columns/`trip_assignments` (006), `exceptions` + computed `sla_status` (007), document/rate/billing tables (008) attach to `trips` without changing 005's read models' contract.
