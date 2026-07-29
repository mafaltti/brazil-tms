# API Contracts — Trip Cancellation (017)

**Date**: 2026-07-27 · **Spec**: [spec.md](../spec.md) · **Research**: [research.md](../research.md)

All routes live in the Next.js BFF (`apps/web/app/api/**`), behind `requireAuth()` +
`requirePermission()` (BFF-only authz, Constitution IV). Errors flow through the existing
`handleRouteError` (`ZodError` → 400 with field issues; `Unauthorized` → 401; `Forbidden` → 403;
`Conflict` → 409 `{ code, message }`; `NOT_FOUND` → 404).

## 1. `POST /api/trips/[id]/cancel` — NEW

Cancels one trip with full §19.5 justification. **The only path to `cancelled`.**

- **Permission**: `cancel_trip` (admin, operations_manager, dispatcher).
- **Dispatcher limit** (§18 "Limited", clarification 2026-07-27): when `ctx.role === "dispatcher"`,
  the route passes `allowedSourceStatuses: DISPATCH_PHASE_TRIP_STATUSES` (`received | assigned |
  confirmed`) to `cancelTrip`; other statuses → 409 `NOT_CANCELLABLE_BY_ROLE`.
- **Request body** (client-supplied timestamp is **ignored** — `cancelled_at` is server `now()`, FR-005):

```json
{
  "reasonCode": "no_vehicle_available",
  "responsibleParty": "brazil_transports_caused",
  "billingImpact": "no_charge"
}
```

- `reasonCode` / `billingImpact`: must match an ACTIVE `cancellation_options` row of the right kind.
- `responsibleParty`: `customer_caused | brazil_transports_caused | carrier_caused | unknown`.

- **Response 200**: `{ "item": TripDetail }` — the same DTO the detail page renders (status
  `cancelled`, cancellation fields populated, timeline including the new `status_change` event,
  SLA cleared).

- **Errors**:

| Status | code | When |
|---|---|---|
| 400 | (Zod issues) | missing/blank reasonCode, responsibleParty, or billingImpact (FR-006) |
| 401 / 403 | — | unauthenticated / role lacks `cancel_trip` (incl. control_tower, FR-007) |
| 404 | `NOT_FOUND` | unknown trip id |
| 409 | `NOT_CANCELLABLE` | `canTransition(current, "cancelled")` is false (terminal/billing statuses) |
| 409 | `NOT_CANCELLABLE_BY_ROLE` | dispatcher on a post-`confirmed` trip (NEW code) |
| 409 | `STALE_TRANSITION` | concurrent status change between check and guarded update |
| 409 | `CANCELLATION_NOT_CONFIGURED` | a required options kind has zero active rows (FR-011) |
| 409 | `INVALID_REASON_CODE` / `INVALID_BILLING_IMPACT` | code not among active options |

## 2. `GET /api/cancellation-options` — NEW

Feeds the cancel dialog's selects.

- **Permission**: `cancel_trip`.
- **Response 200** (active rows only, ordered `kind, sort_order`; bounded config list, no pagination):

```json
{
  "items": [
    { "kind": "reason", "code": "cancelled_by_customer", "labelPt": "Cancelado pelo cliente", "sortOrder": 1 },
    { "kind": "billing_impact", "code": "no_charge", "labelPt": "Sem cobrança", "sortOrder": 1 }
  ]
}
```

## 3. `POST /api/trips/[id]/status` — CHANGED (loophole close, FR-008)

New refusal, mirroring the existing assignment-phase refusal:

- `toStatus: "cancelled"` → **409** `{ "code": "USE_CANCELLATION_ENDPOINT", "message":
  "Cancelamento não permitido por esta rota; use o endpoint de cancelamento." }`
- Everything else about the route is unchanged (`update_trip_status`, milestone semantics,
  `USE_ASSIGNMENT_ENDPOINT` for `received|assigned|confirmed`). `disputed` handling is untouched
  (out of scope).

## 4. UI consumption (hooks, `apps/web/lib/trips/client.ts`)

- `useCancelTrip(tripId)` → `POST /api/trips/[id]/cancel`; on success invalidates the `["trips"]`
  query root (detail, control-tower list, dispatch queue all refetch — polling remains the ambient
  freshness mechanism, NO Realtime).
- `useCancellationOptions()` → `GET /api/cancellation-options`; standard query defaults (config
  data; no aggressive polling).

Surfaces rendering the trigger (visibility = `cancelScope` covers current status AND
`canTransition(status, "cancelled")`; scope computed server-side: admin/ops_manager → `any`,
dispatcher → `dispatch_phase`, others → `none`):

1. Trip Detail header action (`components/trips/trip-detail/*`).
2. Dispatch board row action (`components/trips/dispatch/dispatch-board.tsx`).
3. Control Tower table row action (`components/trips/control-tower-table.tsx`).

All three open the single shared `CancelTripDialog` (pt-BR labels via the existing i18n catalog).
