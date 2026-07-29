# BFF Endpoints — Dispatch Assignment (006)

All endpoints are Next.js App Router Route Handlers under `apps/web/app/api/`. Every handler follows the established contract: `const ctx = await requireAuth()` (→ `401 UNAUTHORIZED`) → `requirePermission(ctx, key)` (→ `403 FORBIDDEN`) → Zod `schema.parse(body)` (→ `400 VALIDATION`) → `@brazil-tms/db` service/read-model → `handleRouteError(error)` (maps `Conflict`→`409 <code>`, etc.). Success body shape `{ item, ... }`; error body `{ error: { code, message } }`. Every route file sets `export const dynamic = "force-dynamic"` and exports **only** HTTP method handlers. Timestamps UTC; messages pt-BR.

Legend: **NEW** = added by 006 · **EXTEND** = existing endpoint gains fields/filters.

---

## 1. `POST /api/trips/:id/assignment` — assign **or** reassign  **(NEW)**

**Permission**: `assign_resources`.

**Body** (`assignTripSchema`):
```jsonc
{
  "driverId": "uuid",
  "vehicleId": "uuid",
  "trailerId": "uuid | null",      // optional
  "carrierId": "uuid | null",      // required when the assigned resources are subcontracted
  "expectedFromStatus": "validated | assigned | confirmed",  // optimistic-concurrency expectation
  "notes": "string?",
  "overrideReason": "string?"      // required to proceed past WARN findings
}
```

**Behaviour** (service `assignTrip`): validates the minimum-required set (driver + vehicle; carrier if subcontracted); gathers eligibility context; runs the server-authoritative evaluator. If the trip is `validated` → **assign** (insert current row + `validated → assigned`); if `assigned`/`confirmed` → **reassign** (supersede the current row, insert a new current row, **no status change**). One DB transaction writes the row(s) + (for assign) a `trip_events` `status_change` row + an `audit_logs` row (`trip.assign` / `trip.reassign`, `reason` = override reason when present).

**Responses**:
| Status | Code | When |
|--------|------|------|
| `200` | — | `{ item: TripDetailView, findings: Finding[] }` (findings = overridden WARNs, if any) |
| `400` | `VALIDATION` | bad body |
| `403` | `FORBIDDEN` | lacks `assign_resources` |
| `404` | `NOT_FOUND` | trip missing |
| `409` | `INCOMPLETE_ASSIGNMENT` | min-required set not met |
| `409` | `OVERRIDE_REQUIRED` | WARN finding(s) present and no `overrideReason` — body includes `findings` |
| `409` | `ASSIGNMENT_BLOCKED` | any BLOCK finding — body includes `findings` (not overridable) |
| `409` | `STALE_TRANSITION` | `current_status` ≠ `expectedFromStatus` (incl. lost single-current-assignment race) |
| `409` | `ILLEGAL_TRANSITION` | trip not in an assignable status |

## 2. `DELETE /api/trips/:id/assignment` — unassign  **(NEW)**

**Permission**: `assign_resources`. **Body**: `{ expectedFromStatus: "assigned", notes?: string }`.

Supersedes the current assignment (retained as history) and transitions `assigned → validated` (status_change event; `trip.unassign` audit). → `200 { item }`; `409 STALE_TRANSITION`/`ILLEGAL_TRANSITION`; `404`.

## 3. `POST /api/trips/:id/assignment/confirm` — confirm  **(NEW)**

**Permission**: `assign_resources`. **Body** (`confirmAssignmentSchema`): `{ expectedFromStatus: "assigned", notes?: string }`.

Re-runs the evaluator (catches resource drift since assignment). Refuses on any **unresolved BLOCK**; otherwise updates the current assignment row (`confirmed_by/at`) and transitions `assigned → confirmed` (status_change event; `trip.confirm` audit).
| `200` | `{ item }` |
| `409 ASSIGNMENT_BLOCKED` | unresolved BLOCK at confirm time — body includes `findings` |
| `409 STALE_TRANSITION` / `ILLEGAL_TRANSITION` / `404 NOT_FOUND` | as above |

## 4. `POST /api/trips/:id/assignment/check` — dry-run eligibility  **(NEW)**

**Permission**: `assign_resources`. **Body** (`checkAssignmentSchema`): candidate `{ driverId?, vehicleId?, trailerId?, carrierId? }`.

**Read-only**: gathers context + runs the evaluator; **writes nothing**. Powers the inline warnings in the assignment panel / Dispatch Board so the UI displays — but never owns — conflict authority. → `200 { findings: Finding[] }` (`findings = []` ⇒ clean). `404` if trip missing.

`Finding = { check, resourceKind, resourceId, severity: "block"|"warn", code }` — see [data-model.md §3.1](../data-model.md).

---

## 5. `GET /api/trips` — Control Tower board  **(EXTEND)**

Already gated `view_all_trips` (005). 006 adds:
- **Filters** (`trip-board.ts` schema): `assigned` (`"true"|"false"` ⇒ has / has-no current assignment), `driverId`, `vehicleId`, `carrierId`.
- **Row fields** (`TripBoardRow`): `isAssigned`, `assignedDriverName`, `assignedVehiclePlate`, `assignedCarrierName`.

The **Dispatch Board** screen and the **"Unassigned"** view are clients of this endpoint (`?assigned=false&scope=active&sort=pickup`) — no separate board endpoint.

## 6. `GET /api/trips/:id` — Trip Detail  **(EXTEND)**

Already gated `view_all_trips` (005). `TripDetailView` gains `currentAssignment` (resources + names + notes + overrideReason + assigned/confirmed by/at) and `assignmentHistory[]` (superseded rows, newest-first). Read-only.

## 7. `GET /api/dashboard/summary` — Home Dashboard  **(EXTEND)**

Already gated `view_all_trips` (005). 006 fills `unassignedTrips` (was `null`) with the count of **active trips having no current assignment**. The dashboard widget renders the count + deep-link automatically (no UI change).

---

## Notes

- **No new permission key** — all writes gated on the pre-declared `assign_resources` (first enforced here; see [permission-matrix.md](./permission-matrix.md)). Reads stay on `view_all_trips`.
- **Resource selection** for the panel/board pickers is populated from the **extended `getTripFilterOptions`** (active drivers/vehicles/trailers/carriers as `{ id, label }`), loaded server-side by the page loaders and surfaced to the client. These option lists are readable under `view_all_trips` — 006 adds **no** resource-list endpoint and does **not** call 002's `manage_fleet_data`-gated `/api/master-data/*` fleet endpoints from the dispatch UI (the `assign_resources` Dispatcher role lacks `manage_fleet_data`, so that path would 403).
- **HTTP-status assertions** (401/403/404/409 + payloads) are tested in Playwright `e2e/` (the project has no `route.test.ts`); service correctness is tested in `apps/web/lib/**/*.test.ts` + `packages/shared` unit tests.
