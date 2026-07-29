# Contract: BFF Endpoints (feature 005)

**Feature**: 005-control-tower | **Spec**: [spec.md](../spec.md) · **Data model**: [data-model.md](../data-model.md)

The Control Tower / Trip Detail / Dashboard read surface plus the operational-field edit and CSV export. All handlers are Next.js App Router Route Handlers under `apps/web/app/api/` exporting `export const dynamic = "force-dynamic"` and only HTTP-verb functions (helpers live elsewhere). Every handler: `const ctx = await requireAuth()` (→ `401` no session, `403` onboarding) → `requirePermission(ctx, <key>)` (→ `403`) → Zod-parse input (→ `400 VALIDATION`) → call a read model / 003 service → shape JSON; errors via `handleRouteError` (maps `Conflict`→`409 { error.code }`). Reads are gated `view_all_trips`; the plan edit is gated `manage_trips` (see [permission-matrix.md](./permission-matrix.md)). Freshness is client polling (no Realtime). Shapes are in the "Shared returned shapes" section at the bottom.

### `GET /api/trips`  *(EXTENDED from 003 — re-gated + full query)*

- **Permission**: `view_all_trips` *(was `manage_trips` in 003 — re-gated so all internal roles can view, R1)*.
- **Query** (`tripBoardQuerySchema`, R3/R8): `?customerId=` (uuid), `?status=` (one-or-many `trip_status`), `?billingStatus=` (`billing_pending|billing_ready|billed|disputed`), `?originLocationId=` / `?destinationLocationId=` / `?laneId=` (uuid), `?vehicleType=` (`vehicle_type`), `?pickupFrom=` / `?pickupTo=` (ISO date, BRT day math → UTC), `?q=` (external trip ID / customer / lane), `?scope=` (`active` default | `all`, R4), `?sort=` (`pickupStart` default | `customer` | `status` | `createdAt` | `updatedAt`), `?dir=` (`asc|desc`), `?limit=` (1–200, default 50), `?offset=` (≥0, default 0).
- **Behavior**: `queryTripBoard(filters, sort, page)` — server-side filter (AND) + sort + pagination over name-enriched rows; default scope = active/open trips ordered by planned pickup. Returns the page plus `total` for pagination controls. No invented assignment/SLA fields.
- **Responses**: `200 { items: TripBoardRow[], total: number, limit: number, offset: number }`; `400 VALIDATION`; `401`; `403`.
- Traceability: US1, FR-001..FR-006a, FR-009, FR-010; SC-001, SC-002.

### `GET /api/trips/:id`  *(EXTENDED from 003 — re-gated + enriched)*

- **Permission**: `view_all_trips` *(was `manage_trips`)*.
- **Behavior**: `getTripDetailView(id)` — 003's `loadTripDetail` (trip record: immutable `original_plan` + live `planned_*` + `current_status` + cancellation fields; latest 50 `trip_events`; latest 50 trip `audit_logs`) + derived `billingStatus` + display-name enrichment (customer, origin/destination, lane) + `importBatchId`. Assignment / exceptions / documents / billing **detail are not included** — those render as placeholder sections (006/007/008). `slaStatus` returned as-is (007 placeholder).
- **Responses**: `200 { item: TripDetailView }`; `401`; `403`; `404`.
- Traceability: US2, FR-011..FR-020, SC-003.

### `PATCH /api/trips/:id/plan`  *(NEW — reuses 003 `updateTripPlan`)*

- **Permission**: `manage_trips` (Admin + Ops Manager; "Limited" scope BLOCKED — §18).
- **Body**: `application/json` (`updateTripPlanSchema`, R11) — partial of the 10 live plan fields (`plannedPickupWindowStart/End`, `plannedDeliveryWindowStart/End`, `plannedVehicleType`, `plannedVolumeUnits`, `plannedWeightKg`, `plannedPalletCount`, `plannedRouteNotes`, `plannedServiceRequirements`), ≥1 required, window start ≤ end; optional `authorizedReview: boolean`.
- **Behavior**: Hard-block edits when `current_status ∈ {completed, billing_pending, billing_ready, billed, cancelled, disputed}` → `409 EDIT_NOT_ALLOWED` ("before completion", TRIP-005). Otherwise call `updateTripPlan(id, changes, { authorizedReview }, ctx.userId)` — preserves the immutable original plan, audits critical-field changes as `trip.plan_update`, and enforces 003's post-`confirmed` review gate. No status transition is performed.
- **Responses**: `200 { item: TripDetailView }`; `400 VALIDATION`; `401`; `403`; `404`; `409 EDIT_NOT_ALLOWED`; `409 REVIEW_REQUIRED` (past `confirmed` without `authorizedReview`); `409 STALE_TRANSITION` (concurrent change).
- Traceability: US3, FR-022..FR-027, SC-004.

### `GET /api/trips/export`  *(NEW — synchronous capped CSV)*

- **Permission**: `view_all_trips`.
- **Query**: `tripExportQuerySchema` = the board query **without** `limit`/`offset` (R13).
- **Behavior**: `exportTripRows(filters, cap=10000)` over the same `where`/sort as the board. Build CSV (UTF-8 **BOM** + board columns) and return as an attachment. If the matching row count exceeds the cap → `422 EXPORT_TOO_LARGE` (prompt to narrow filters; **no silent truncation**). Respects the caller's view permission. Not stored, not audited (MVP).
- **Responses**: `200 text/csv` (`Content-Disposition: attachment; filename="trips-<timestamp>.csv"`); `400 VALIDATION`; `401`; `403`; `422 EXPORT_TOO_LARGE`.
- Traceability: US5, FR-033, SC-006.

### `GET /api/dashboard/summary`  *(NEW — daily dashboard metrics)*

- **Permission**: `view_all_trips`.
- **Behavior**: `queryDashboardMetrics()` — returns the eight §15.2 widgets. **Computed**: `tripsTodayByStatus` (pickup today, BRT) and `billingPendingCount`. **`null`** (UI placeholder): `tripsAtRisk`, `unassignedTrips`, `activeExceptions`, `onTimePickupPct`, `onTimeArrivalPct`, `completedMissingDocuments` (owned by 006/007/008). Each populated widget includes the board filter params for one-click deep-linking (FR-030).
- **Responses**: `200 { summary: DashboardSummary }`; `401`; `403`.
- Traceability: US4, FR-028..FR-032, SC-005.

## Shared returned shapes

```typescript
// Derived projection (003): non-null only for billing-phase statuses.
type BillingStatus = "billing_pending" | "billing_ready" | "billed" | "disputed" | null;

type TripBoardRow = {
  id: string; externalTripId: string | null;
  customerId: string; customerName: string;
  originCode: string; originName: string;
  destinationCode: string; destinationName: string;
  laneLabel: string | null;
  currentStatus: TripStatus; billingStatus: BillingStatus;
  slaStatus: string | null;                       // 007 placeholder
  plannedPickupWindowStart: string | null; plannedPickupWindowEnd: string | null;
  plannedDeliveryWindowStart: string | null; plannedDeliveryWindowEnd: string | null;
  plannedVehicleType: string | null; updatedAt: string;
};

// 003's TripDetail (originalPlan, planned_*, cancellation_*, events[], audit[]) + 005 enrichment.
type TripDetailView = TripDetail & {
  customerName: string;
  originCode: string; originName: string;
  destinationCode: string; destinationName: string;
  laneLabel: string | null;
  importBatchId: string | null;
};

type DashboardSummary = {
  tripsTodayByStatus: { status: TripStatus; count: number }[];
  billingPendingCount: number;
  tripsAtRisk: number | null;            // 007
  unassignedTrips: number | null;        // 006
  activeExceptions: number | null;       // 007
  onTimePickupPct: number | null;        // 007
  onTimeArrivalPct: number | null;       // 007
  completedMissingDocuments: number | null; // 008
};
```
