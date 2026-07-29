# Contract: BFF Endpoints (feature 003)

**Feature**: 003-trip-domain-lifecycle | **Spec**: [../spec.md](../spec.md) ·
**Data model**: [../data-model.md](../data-model.md) · **Domain API**: [trip-domain-api.md](./trip-domain-api.md)

This slice is foundational and mostly headless. Its **only** BFF surface is a **read-only trip inspector**
(the "minimal internal/admin visibility needed to verify the model"). The mutating domain operations
(create, transition, plan-update, cancel) are exposed as the **reusable service/domain API**
([trip-domain-api.md](./trip-domain-api.md)) that slices 004 (import), 005 (control tower), 006 (dispatch),
and 007 (execution) call from their own endpoints — they are **not** exposed as operational endpoints here,
and are verified by Vitest integration tests against the dev DB.

Handlers live under `apps/web/app/api/trips/*`. The browser never talks to Postgres/PostgREST directly; all
access goes through these handlers. Each enforces auth via `requireAuth()` + `requirePermission()` (001).

**Conventions** (inherited from features 001/002 `contracts/bff-endpoints.md`)

- **AuthZ**: `401` = no valid/active session; `403` = authenticated but lacks the permission; `404` = trip
  not found; `400` = Zod validation error. Read endpoints never mutate.
- URL conventions: `/api/trips` (list), `/api/trips/:id` (detail).

### `GET /api/trips`

- **Permission**: `manage_trips`.
- **Query**: `?status=` (filter by `trip_status`), `?customerId=`, `?q=` (external_trip_id search),
  `?limit=` (default 50).
- **Behavior**: read-only list of trips (newest first), each with the derived `billingStatus` projection.
- **Responses**: `200 { items: TripSummary[] }`; `401`; `403`.
- Traceability: US2, SC-005 (single status surfaced), "minimal internal/admin visibility".

### `GET /api/trips/:id`

- **Permission**: `manage_trips`.
- **Behavior**: read-only trip detail = the trip record (immutable `original_plan` + live `planned_*` +
  `current_status` + cancellation fields) + derived `billingStatus` + the latest 50 `trip_events` (newest
  first) + the latest 50 `audit_logs` for `entity_type='trip', entity_id=:id` (newest first). This is the
  verification view for planned-vs-executed (events), the status, and the audit trail.
- **Responses**: `200 { item: TripDetail }`; `401`; `403`; `404`.
- Traceability: US1 (planned vs executed visible), US2 (status), US3 (audit present), US5 (billing projection),
  SC-002/SC-003/SC-006.

## Shared returned shapes (TypeScript-like)

```typescript
type BillingStatus = "billing_pending" | "billing_ready" | "billed" | "disputed" | null; // derived (R3)

type TripSummary = {
  id: string; customerId: string; externalTripId: string | null;
  originLocationId: string; destinationLocationId: string; laneId: string | null;
  currentStatus: TripStatus;          // the single enum
  billingStatus: BillingStatus;       // projection of currentStatus
  slaStatus: string | null;           // placeholder, not computed here
  createdAt: string; updatedAt: string;
};

type TripEvent = {
  id: string; eventType: TripEventType;
  statusBefore: TripStatus | null; statusAfter: TripStatus | null;
  eventTimestamp: string | null;      // actual milestone time (UTC ISO)
  source: TripEventSource; actorUserId: string | null; locationId: string | null;
  notes: string | null; createdAt: string;
};

type AuditEntry = {
  id: string; action: AuditAction; previousValue: unknown; newValue: unknown;
  actorUserId: string; reason: string | null; createdAt: string;
};

type TripDetail = TripSummary & {
  originalPlan: unknown;              // immutable import snapshot (TRIP-006)
  plannedPickupWindowStart: string | null; plannedPickupWindowEnd: string | null;
  plannedDeliveryWindowStart: string | null; plannedDeliveryWindowEnd: string | null;
  plannedVehicleType: VehicleType | null;
  plannedVolumeUnits: number | null; plannedWeightKg: number | null; plannedPalletCount: number | null;
  plannedRouteNotes: string | null; plannedServiceRequirements: unknown;
  cancellationReasonCode: string | null; cancellationResponsibleParty: ResponsibleParty | null;
  cancellationBillingImpact: string | null; cancelledAt: string | null; disputedFromStatus: TripStatus | null;
  events: TripEvent[]; audit: AuditEntry[];
};
```
