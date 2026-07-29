# BFF Endpoints — Execution Events, Exceptions, SLA Risk & Alerts (007)

All endpoints are Next.js App Router Route Handlers under `apps/web/app/api/`. Every handler follows the established contract: `const ctx = await requireAuth()` (→ `401 UNAUTHORIZED`) → `requirePermission(ctx, key)` (→ `403 FORBIDDEN`) → Zod `schema.parse(body)` (→ `400 VALIDATION`) → `@brazil-tms/db` service / read-model → `handleRouteError(error)` (maps `Conflict`→`409 <code>`; the `NOT_FOUND` code is special-cased to `404` via `apiError(404, ...)`). Success body shapes follow the existing convention: `{ item }` for a single resource / mutation result, `{ items }` for a list, `{ summary }` for the dashboard. Error body `{ error: { code, message } }`. Every route file sets `export const dynamic = "force-dynamic"` and exports **only** HTTP method handlers (helpers live in a sibling `_helpers.ts`). Timestamps UTC; messages pt-BR.

Authorization adds **no new permission key** (FR-027). It **first-enforces** the pre-declared 001 keys `update_trip_status` (milestones / status / notes), `create_exceptions`, `resolve_exceptions`, and **reuses** the already-enforced `manage_commercial_data` (002) for per-customer SLA-rule administration. All **reads** (timeline, exceptions, SLA, reason codes, SLA rules, alerts) stay on `view_all_trips`. Alert acknowledge is a read-surface triage mutation gated on `view_all_trips` (no write key — matches the spec clarification "reads … alerts stay on `view_all_trips`" and SC-009's four write keys).

Legend: **NEW** = added by 007 · **EXTEND** = existing endpoint gains fields/filters.

**SLA & alert authority is server-side.** The pure `evaluateSlaRisk` evaluator (`@brazil-tms/shared`) is invoked by `recomputeTripSla` (`@brazil-tms/db`) **synchronously inside the mutation transaction** of every state-changing write below (milestone, note, exception create/transition; and the 006 assignment/confirm paths) so `sla_status`/`sla_reasons` flip the instant the change commits — before any poll. The **high-severity-exception alert** is generated synchronously in the exception-create service. Purely **time-based** SLA transitions and alerts (passed confirmation cutoff, missed arrival with no triggering user action) are produced by the **worker sweep** (`runSlaSweep`, ~5-min configurable cron, pg-boss). Both paths are idempotent: alert generation is `INSERT … ON CONFLICT (alerts_trip_case_open_uq) DO NOTHING`; SLA recompute is deterministic on identical evaluator inputs (worker uses `SELECT … FOR UPDATE` per trip). The UI never computes SLA (FR-014). No Realtime — freshness is polling (FR-030).

---

## 1. `POST /api/trips/:id/status` — record execution milestone / status change  **(NEW)**

**Permission**: `update_trip_status`.

**Body** (`transitionTripSchema`, reused from 003 / `@brazil-tms/shared`):
```jsonc
{
  "toStatus": "at_origin | loading | loaded | in_transit | at_destination | unloading | unloaded | completed | …",
  "expectedFromStatus": "confirmed | at_origin | …",  // optimistic-concurrency expectation
  "eventTimestamp": "ISO-8601?",   // actual milestone time; defaults to now
  "source": "operator_manual?",    // milestone calls pass operator_manual
  "notes": "string?"               // ≤2000
}
```

**Behaviour** (service `transitionTripStatus`, reused from 003 — **the status machine is NOT redefined**): the milestone set drives the existing legal edges `confirmed→at_origin→[loading]→loaded→in_transit→at_destination→[unloading]→unloaded→completed` (`loading`/`unloading` optional sub-states, recorded as ordinary `status_change` events — **no new `trip_event_type` member**, D5). One DB transaction does the optimistic-concurrency-guarded `trips` update + the `status_change` `trip_events` row (capturing actor, source, timestamp, previous/new status — EVT-002) + the `trip.status_change` audit row, then calls `recomputeTripSla` and returns the reloaded `TripDetailView`.

**Responses**:
| Status | Code | When |
|--------|------|------|
| `200` | — | `{ item: TripDetailView }` (recomputed `slaStatus`/`slaReasons` reflected immediately) |
| `400` | `VALIDATION` | bad body |
| `403` | `FORBIDDEN` | lacks `update_trip_status` |
| `404` | `NOT_FOUND` | trip missing |
| `409` | `ILLEGAL_TRANSITION` | edge not legal in the status machine (e.g. Loaded before At Origin) |
| `409` | `STALE_TRANSITION` | `current_status` ≠ `expectedFromStatus` (concurrent advance — loser rejected, not overwritten) |

## 2. `POST /api/trips/:id/events` — free-form note / non-status event  **(NEW)**

**Permission**: `update_trip_status`.

**Body** (`addTripNoteSchema`):
```jsonc
{
  "notes": "string",            // required, ≤2000
  "locationId": "uuid | null",  // optional
  "exceptionId": "uuid | null", // optional link to an exception
  "eventTimestamp": "ISO-8601?" // defaults to now
}
```

**Behaviour** (service `addTripNote`): inserts a `trip_events` row with `event_type='note'` (the **one** new event-type member, R6), `source='operator_manual'`, **no status change**, plus a `trip.note` audit row — same transaction shape, returns `loadTripDetail`. SLA is recomputed (a note carrying an `exception_id` does not itself change risk, but the call keeps the path uniform). → `200 { item: TripDetailView }`; `400 VALIDATION`; `403 FORBIDDEN`; `404 NOT_FOUND`.

---

## 3. `POST /api/trips/:id/exceptions` — create exception  **(NEW)**

**Permission**: `create_exceptions`.

**Body** (`createExceptionSchema`):
```jsonc
{
  "reasonCodeId": "uuid",                         // required; must be active
  "severity": "low | medium | high?",             // defaults from reason code, overridable
  "responsibleParty": "customer_caused | brazil_transports_caused | carrier_caused | force_majeure | unknown?", // defaults from reason code, overridable
  "ownerUserId": "uuid?",                          // defaults to the creating actor; reassignable
  "description": "string"                          // required, ≤2000
}
```

**Behaviour** (service `createException`): resolves the reason code (its `default_severity`/`default_responsible_party` pre-fill when omitted; **category is derived** from `reason_codes.category`, never stored on the exception), inserts the `exceptions` row with `status='open'`, `opened_at=now`, `owner_user_id` (defaulting to the actor). One transaction writes the row + an `exception.create` audit row, then — when `severity='high'` — generates the `high_severity_exception` alert synchronously (`ON CONFLICT DO NOTHING`) and calls `recomputeTripSla` (an open high-severity exception is an **At Risk** trigger). Returns the reloaded `TripDetailView` (its `exceptions[]` + recomputed SLA refreshed).

**Responses**:
| Status | Code | When |
|--------|------|------|
| `201` | — | `{ item: TripDetailView }` |
| `400` | `VALIDATION` | bad body |
| `403` | `FORBIDDEN` | lacks `create_exceptions` |
| `404` | `NOT_FOUND` | trip missing |
| `409` | `INVALID_REASON_CODE` | `reasonCodeId` unknown or inactive |

## 4. `PATCH /api/exceptions/:id` — edit exception (owner / severity / responsible party / description)  **(NEW)**

**Permission**: `resolve_exceptions`.

**Body** (`updateExceptionSchema`, all optional, ≥1 present): `{ ownerUserId?, severity?, responsibleParty?, description? }`.

**Behaviour** (service `updateException`): edits the mutable fields of a non-terminal exception in one transaction with an `exception.update` audit row, then `recomputeTripSla` (a severity change to/from `high` flips the SLA trigger and may add/auto-resolve the high-severity alert). Returns the reloaded `TripDetailView`.

**Responses**:
| Status | Code | When |
|--------|------|------|
| `200` | — | `{ item: TripDetailView }` |
| `400` | `VALIDATION` | bad body |
| `403` | `FORBIDDEN` | lacks `resolve_exceptions` |
| `404` | `NOT_FOUND` | exception missing |
| `409` | `INVALID_REASON_CODE` | new owner not an internal user (or analogous referential check) |

## 5. `POST /api/exceptions/:id/transition` — lifecycle transition (Monitoring / Resolved / Cancelled)  **(NEW)**

**Permission**: `resolve_exceptions`.

**Body** (`transitionExceptionSchema`):
```jsonc
{
  "expectedFromStatus": "open | monitoring", // optimistic-concurrency expectation
  "toStatus": "monitoring | resolved | cancelled",
  "closureNotes": "string?"                  // REQUIRED when toStatus = resolved (≤2000)
}
```

**Behaviour** (service `transitionException`, mirroring 003's transition pattern): pre-tx legality via `canTransitionException` over the legal map — `open↔monitoring`; `open→resolved`, `open→cancelled`, `monitoring→resolved`, `monitoring→cancelled`; **`resolved`/`cancelled` terminal (no reopen)**. Inside one transaction: the guarded conditional UPDATE (`WHERE id = ? AND status = expectedFromStatus` → 0 rows ⇒ `Conflict("STALE_EXCEPTION")`); on `resolved`, set `resolved_at=now` + persist `closure_notes`; write the `exception.resolve` (Resolved) / `exception.cancel` (Cancelled) / `exception.update` (Open↔Monitoring) audit row; then `recomputeTripSla` (resolving/cancelling a high-severity exception clears the trigger and auto-resolves its alert). Returns the reloaded `TripDetailView`.

**Responses**:
| Status | Code | When |
|--------|------|------|
| `200` | — | `{ item: TripDetailView }` |
| `400` | `VALIDATION` | bad body (incl. missing `closureNotes` on Resolved) |
| `403` | `FORBIDDEN` | lacks `resolve_exceptions` |
| `404` | `NOT_FOUND` | exception missing |
| `409` | `ILLEGAL_TRANSITION` | edge not legal (e.g. reopen from terminal) |
| `409` | `STALE_EXCEPTION` | `status` ≠ `expectedFromStatus` (concurrent change) |

## 6. `GET /api/exceptions` — Exception Management list  **(NEW)**

**Permission**: `view_all_trips`.

**Query** (`exceptionFilterSchema` — EXC-013 / FR-013 filters): `severity`, `customerId`, `laneId`, `reasonCodeId`, `ownerUserId`, `age` (opened-before window), plus standard paging/sort. Category filtering joins through `reason_code_id` (category is derived).

**Behaviour** (read `queryExceptions(filters)`): returns the filtered exception queue rows (trip ref, customer, lane, reason code + derived category, severity, status, owner, opened/resolved timestamps). → `200 { items: ExceptionListRow[] }`. Read-only.

## 7. `GET /api/reason-codes` — active reason-code list  **(NEW)**

**Permission**: `view_all_trips`.

Returns the active `reason_codes` (`{ id, code, category, labelPt, defaultSeverity, defaultResponsibleParty }`) ordered by `sort_order` — powers the exception-create form's reason picker and its defaults pre-fill. → `200 { items: ReasonCodeDto[] }`. Read-only.

---

## 8. `GET /api/customer-sla-rules` · `POST /api/customer-sla-rules` — list / create  **(NEW)**

**Permission**: GET `view_all_trips` · **POST `manage_commercial_data`**.

**POST body** (`createSlaRuleSchema`):
```jsonc
{
  "customerId": "uuid",
  "laneId": "uuid | null",          // optional scope
  "vehicleType": "<vehicle_type> | null", // optional scope
  "pickupToleranceMinutes": 0,       // integer ≥ 0
  "deliveryToleranceMinutes": 0,     // integer ≥ 0
  "confirmationCutoffMinutes": 120,  // integer ≥ 0 — lead time before pickup
  "atRiskWarningMinutes": 60,        // integer ≥ 0 — at-risk warning window
  "effectiveStart": "ISO-8601 | null",
  "effectiveEnd": "ISO-8601 | null"
}
```

**Behaviour**: GET `queryCustomerSlaRules` lists rules (→ `200 { items }`). POST `createCustomerSlaRule` inserts a rule (one transaction + `sla_rule.create` audit) → `201 { item }`. Single-applicable-rule precedence (**lane > vehicle-type > customer-default, tie-break latest `effective_start`**) is resolved at evaluation time in the evaluator's `ORDER BY … LIMIT 1` query, **not** a DB constraint — overlapping scopes are allowed. A customer with **no** matching rule is evaluated on `DEFAULT_SLA_POLICY` and reported **SLA sign-off blocked** (FR-022).

**Responses** (POST): `200`/`201` `{ item }`; `400 VALIDATION`; `403 FORBIDDEN` (lacks `manage_commercial_data`); `404 NOT_FOUND` (customer/lane missing).

## 9. `PATCH /api/customer-sla-rules/:id` — update  **(NEW)**

**Permission**: `manage_commercial_data`.

**Body** (`updateSlaRuleSchema`, partial of create incl. `active`). Updates the rule in one transaction + `sla_rule.update` audit. → `200 { item }`; `400 VALIDATION`; `403 FORBIDDEN`; `404 NOT_FOUND`.

---

## 10. `GET /api/alerts` — active/acknowledged alert list + counts  **(NEW)**

**Permission**: `view_all_trips`.

**Query** (optional): `state` (`active`/`acknowledged`), `tripId`. Returns alerts whose `state IN ('active','acknowledged')` (newest-first) with the per-case/severity counts that feed the in-app alert surface and dashboard. → `200 { items: AlertDto[], counts: {...} }`. Read-only — `resolved` rows are excluded (the worker auto-resolves cleared conditions).

## 11. `POST /api/alerts/:id/acknowledge` — acknowledge / dismiss  **(NEW)**

**Permission**: `view_all_trips` (read-surface triage mutation — no write key; SC-009).

**Body** (`acknowledgeAlertSchema`): `{}` (or empty). Sets `state='acknowledged'`, `acknowledged_by_user_id=actor`, `acknowledged_at=now`. An acknowledged alert is **not** re-spammed while its condition still holds (D3 — uniqueness scope is `active OR acknowledged`); the worker auto-resolves it when the condition clears, and a later recurrence inserts a fresh row. **Not** recorded as an `AuditAction` — accountability lives on the alert row (`acknowledged_by_user_id`/`acknowledged_at`).

**Responses**:
| Status | Code | When |
|--------|------|------|
| `200` | — | `{ item: AlertDto }` |
| `403` | `FORBIDDEN` | lacks `view_all_trips` |
| `404` | `NOT_FOUND` | alert missing |
| `409` | `STALE_ALERT` | alert already `resolved` (condition cleared first) |

---

## 12. `GET /api/trips` — Control Tower board  **(EXTEND)**

Already gated `view_all_trips` (005). 007 adds:
- **Filters** (`trip-board.ts` schema): `slaStatus` (`on_track`/`at_risk`/`late`/`breached`) and an `atRisk` (`"true"`) shorthand for the **"At risk"** view (`sla_status IN ('at_risk','late','breached')`).
- **Row fields** (`TripBoardRow`): `slaStatus` is now **populated** (computed by `recomputeTripSla` / worker; previously passed through uncomputed) and `slaReasons: string[]` is added — surfacing the row-level SLA indicator slice 005 reserved.

The **"At risk"** view is a client of this endpoint (`?atRisk=true&scope=active`) — no separate endpoint.

## 13. `GET /api/trips/:id` — Trip Detail  **(EXTEND)**

Already gated `view_all_trips` (005). `TripDetailView` (via the single `loadTripDetail` loader) gains: `slaReasons: string[] | null` alongside the now-populated `slaStatus`; `exceptionId` surfaced on each `TripEventDto` (the 003 column, previously unsurfaced); `exceptions: ExceptionDto[]` (the trip's exception list — fills the 005 placeholder); and `alerts: AlertDto[]` (the trip's active/acknowledged alerts). The interactive timeline reads the same `desc(createdAt) limit 50` event query (chronological order is a render concern); planned-vs-actual deltas are derived in the read/UI layer from planned windows vs recorded milestone timestamps (no new storage). Read-only.

## 14. `GET /api/dashboard/summary` — Home Dashboard  **(EXTEND)**

Already gated `view_all_trips` (005); body is `{ summary }`. 007 fills the four placeholder nulls in `queryDashboardMetrics`: `tripsAtRisk` (active trips with `sla_status IN ('at_risk','late','breached')`), `activeExceptions` (`exceptions WHERE status IN ('open','monitoring')`), `onTimePickupPct` and `onTimeArrivalPct` (recorded arrival events vs planned windows ± tolerance over the dashboard period). The dashboard `metric()` helper auto-flips placeholder→value with no component change.

---

## Notes

- **No new permission key** (FR-027). Writes: `update_trip_status` (status/note), `create_exceptions`, `resolve_exceptions` (exception edit + transition), `manage_commercial_data` (SLA rules). Reads + alert acknowledge: `view_all_trips`. Grant matrix (001): `update_trip_status` → Admin/Ops-Manager/Dispatcher/Control-Tower; `create_exceptions`/`resolve_exceptions` → those four + Fleet-Coordinator; `manage_commercial_data` → Admin/Ops-Manager.
- **Conflict codes**: reused `NOT_FOUND` (→404), `ILLEGAL_TRANSITION`, `STALE_TRANSITION`; new `STALE_EXCEPTION` (guarded exception transition lost the race), `INVALID_REASON_CODE` (unknown/inactive reason code on exception create), `STALE_ALERT` (acknowledge of an already-resolved alert).
- **New Zod schema files** in `@brazil-tms/shared` (each gets an `export *` in `shared/src/index.ts` after the 006 `trip-assignment`/`trip-board` lines): `schemas/trip-event.ts` (`addTripNoteSchema`; milestone reuses 003's `transitionTripSchema`), `schemas/exception.ts` (`createExceptionSchema`, `updateExceptionSchema`, `transitionExceptionSchema`), `schemas/customer-sla-rule.ts` (`createSlaRuleSchema`, `updateSlaRuleSchema`), `schemas/alert.ts` (`acknowledgeAlertSchema`, `exceptionFilterSchema`); `schemas/trip-board.ts` extended with the `slaStatus`/`atRisk` filter params.
- **Worker note**: time-based SLA recompute and the five time-based alert cases (`unassigned_within_window`, `unconfirmed_within_window`, `missed_origin_arrival`, `missed_departure`, `missed_destination_arrival`) are generated by the pg-boss `runSlaSweep` job (~5-min configurable cron, first scheduled job on the existing single worker). The `high_severity_exception` alert is generated **synchronously by the BFF on exception create** (worker is backstop + auto-resolver). Both paths share `evaluateSlaRisk` and `ON CONFLICT DO NOTHING` idempotency. The two deferred §17 cases (`completed_missing_documents` 008, `billing_blocked_missing_proof` 009) emit nothing in 007.
- **Audit** (FR-028): new actions `exception.create`, `exception.update`, `exception.resolve`, `exception.cancel`, `trip.note`, `sla_rule.create`, `sla_rule.update` (added to `AuditAction` union + `ALL_AUDIT_ACTIONS`, in lockstep). Milestones reuse `trip.status_change`. SLA recompute (derived projection) and alert generate/acknowledge are **not** `AuditAction`s.
- **HTTP-status assertions** (401/403/400/404/409 + payloads) are tested in Playwright `e2e/` (the project has **no** `route.test.ts` — `lib/**` Vitest only covers services); evaluator/lifecycle correctness in `packages/shared` unit tests + `apps/web/lib/**/*.test.ts`.
