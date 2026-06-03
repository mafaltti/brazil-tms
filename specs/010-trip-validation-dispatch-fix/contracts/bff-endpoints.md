# BFF Contracts — 010 Trip Validation Action & Dispatch Queue Hardening

This slice adds **no new endpoint**. It **reuses** one existing route (for validate), **changes the error behavior** of one existing route (assignment), and **narrows the query string** the dispatch board sends to an existing read route. All authorization is enforced in the BFF (Constitution IV). pt-BR only (no `en` catalog).

---

## 1. `POST /api/trips/:id/status` — REUSED UNCHANGED (validate)

The Validate / correction actions call this **existing** route; **no server change**.

- **Permission**: `update_trip_status` (already enforced — `status/route.ts:21-22`). Holders: Admin, Operations Manager, Dispatcher, Control Tower.
- **Body** (`transitionTripSchema`, unchanged): `{ expectedFromStatus: TripStatus, toStatus: TripStatus, source?, eventTimestamp? }`.
- **Validate call**: `{ expectedFromStatus: "received", toStatus: "validated", source: "operator_manual" }`.
- **Correction call**: `{ expectedFromStatus: "validation_error", toStatus: "received", source: "operator_manual" }`.
- **Behavior** (existing `transitionTripStatus`): legality checked by `canTransition` (both edges already legal); guarded `UPDATE … WHERE current_status = expectedFromStatus`; writes one `trip_events` `status_change` row + one `audit_logs` `trip.status_change` record; recomputes SLA — all in one transaction.
- **Responses**: `200 { item: TripDetailView }`; `403` (no `update_trip_status`); `404 NOT_FOUND`; `409 ILLEGAL_TRANSITION` (illegal edge) / `409 STALE_TRANSITION` (status already changed); `400 VALIDATION`.
- **Client**: reuses `useRecordMilestone(id)` (`lib/trips/client.ts:254`) — the generic `/status` mutation; invalidates `["trips"]`.

> Contract guarantee: the slice introduces **no** new permission, body field, or status code on this route. It only exercises a path the UI previously never triggered.

---

## 2. `POST /api/trips/:id/assignment` — CHANGED (assign/reassign branch + NOT_ASSIGNABLE)

- **Permission**: `assign_resources` (unchanged — `assignment/route.ts:28`).
- **Body** (`assignTripSchema`, unchanged): `{ driverId, vehicleId, trailerId?, carrierId?, expectedFromStatus: TripStatus, notes?, overrideReason? }`.

**Before** (`route.ts:32-35`):
```ts
const result =
  input.expectedFromStatus === "validated"
    ? await assignTrip(id, input, ctx.userId)
    : await reassignTrip(id, input, ctx.userId);   // ← every non-"validated" status, incl. received, misrouted here
```

**After** (explicit by-status branch):
```ts
let result;
if (input.expectedFromStatus === "validated") {
  result = await assignTrip(id, input, ctx.userId);
} else if (input.expectedFromStatus === "assigned" || input.expectedFromStatus === "confirmed") {
  result = await reassignTrip(id, input, ctx.userId);
} else {
  // received / validation_error / in-flight / terminal — not assignable. Honest, accurate 409.
  throw new Conflict("NOT_ASSIGNABLE", "A viagem precisa ser validada antes da atribuição.");
}
```

- **New response**: `409 { code: "NOT_ASSIGNABLE", message }` for any non-assignable `expectedFromStatus` (covers **all** such statuses, not only `received`). Mapped by the existing `Conflict → 409` path (`handleRouteError`).
- **Unchanged responses**: `200 { item, findings }` (valid assign/reassign); `403`; `404 NOT_FOUND`; `409 STALE_TRANSITION` / `OVERRIDE_REQUIRED` / `ASSIGNMENT_BLOCKED` / `INCOMPLETE_ASSIGNMENT`; `400 VALIDATION`. The **valid** assign (`validated`) and reassign (`assigned`/`confirmed`) paths are **unchanged** (regression guard).
- **`reassignTrip`'s internal guard** (`trip-assignments.ts:471-476`) is **kept** as server-authoritative defense — after this change it is only ever reached with `assigned`/`confirmed`, but it stays as a backstop (Constitution III).
- **Docstring**: update the route's Conflict-code list to include `NOT_ASSIGNABLE`.

### Client wiring (so the message is shown, not downgraded)

- `assignment-form.tsx` `ERROR_CODES` (line 51-59): **add `"NOT_ASSIGNABLE"`** — otherwise `mapError` degrades it to `REQUEST_FAILED`.
- `pt-BR.json`: **add** `Dispatch.errors.NOT_ASSIGNABLE` = `"A viagem precisa ser validada antes de ser atribuída."` (flat key under the existing `Dispatch.errors` object — no dotted key; next-intl `INVALID_KEY` safe).

---

## 3. `GET /api/trips` (board read) — QUERY NARROWED (no server change)

The Dispatch Board's client constant changes; the **read route and read model are unchanged** (they already support an explicit `status` filter).

- **Before**: `DISPATCH_QUERY = "assigned=false&scope=active&sort=pickupStart"` → `current_status IN (12 ACTIVE_TRIP_STATUSES)` AND unassigned.
- **After**: `DISPATCH_QUERY = "status=validated&assigned=false&sort=pickupStart"` → `current_status = 'validated'` AND unassigned.
- **Why no server change**: `trip-board.ts` already accepts `status` as `oneOrMany(z.enum(TRIP_STATUSES))`; `trips-read.ts:341-343` applies the explicit list via `inArray(trips.currentStatus, query.status)` and the `!query.status?.length` guard (line 357) suppresses the `scope=active` default automatically. `assigned=false` keeps the existing `isNull(boardAsg.id)` filter.
- **Permission**: `view_all_trips` (unchanged).
- **Result**: the queue lists only `validated`, unassigned trips — every row is assignable (SC-002).

---

## Summary of contract changes

| Endpoint | Change | New permission? | New status code? |
|----------|--------|-----------------|------------------|
| `POST /api/trips/:id/status` | reused as-is for validate | No (`update_trip_status`) | No |
| `POST /api/trips/:id/assignment` | explicit branch + `Conflict("NOT_ASSIGNABLE")` | No (`assign_resources`) | `409 NOT_ASSIGNABLE` (new code, existing 409 mapping) |
| `GET /api/trips` (board) | client query `scope=active` → `status=validated` | No (`view_all_trips`) | No |

**Zero** new endpoints, permission keys, or request schemas.
