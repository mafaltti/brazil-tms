# BFF Endpoints — 009 Reporting, Audit Views, Hardening

All endpoints are **read-only GET** handlers under `apps/web/app/api/`, following the existing pattern: `requireAuth()` → `requirePermission(ctx, key)` → parse/validate query params (Zod, `*FromParams`) → call a read model → `NextResponse.json(data)`; errors via `handleRouteError` (`401` Unauthorized, `403` Forbidden, `400` ZodError). **No mutations, no audit writes, no new permission key.** Freshness: client polls at `60 s` (TanStack Query), matching the dashboard.

Conventions reused (see [research.md](../research.md) R5 and the slice-008 contracts): error envelope `{ error: { code, message } }`; success returns data directly (no wrapper beyond the documented shape); ISO date strings cross the boundary.

---

## 1. SLA performance report — `GET /api/reports/sla`

- **Permission**: `view_all_trips`
- **Query** (`reportFilterSchema`): `customerId?`, `laneId?`, `from?` (ISO date), `to?` (ISO date), `groupBy?=customer|lane` (default `customer`). Period defaults to the last completed calendar month (`America/Sao_Paulo`).
- **200** → `SlaReport` (see [data-model.md](../data-model.md) §2): `{ period, provisional, provisionalReason?, groups: SlaReportRow[] }`. `provisional=true` when an included customer lacks `customer_sla_rules` (computed on `DEFAULT_SLA_POLICY`).
- **Reads**: `trips` + `trip_events` (via `onTimeExpr`) + `customer_sla_rules` + `customers`/`lanes`. SLA-state counts from stored `trips.sla_status`; on-time % from the shared predicate (never re-derived).
- **Errors**: `401` no session; `403` lacks `view_all_trips`; `400` invalid filter.

## 2. Exception volume / delay reasons — `GET /api/reports/exceptions`

- **Permission**: `view_all_trips`
- **Query** (`reportFilterSchema`): same shape; period membership by `exceptions.opened_at`.
- **200** → `ExceptionReport` (§3): `{ period, totals{total,open,resolved,avgResolutionMinutes}, byCategory[], bySeverity[], groups[] }`.
- **Reads**: `exceptions` + `reason_codes` + `trips`→`customers`/`lanes` (reuses 007's `queryExceptions` joins).
- **Errors**: as above.

## 3. Billing readiness — `GET /api/reports/billing-readiness`

- **Permission**: `view_all_trips`
- **Query** (`reportFilterSchema`): `customerId?`, `from?`, `to?` (period = month of completion via `billing_items.billing_period`). `groupBy` fixed to `customer`.
- **200** → `BillingReadinessReport` (§4): `{ period, provisional, provisionalReason?, phaseCounts, completedMissingDocuments, pctReadyWithin24h, groups[] }`. `provisional=true` when per-customer document/billing rules are unsupplied (default checklist / manual values).
- **Reads**: `billing_items` + `trips` (`billingStatus` projection) + `trip_events` (completion→`billing_ready` gap, R4) + 008's missing-proof signal.
- **Errors**: as above.

## 4. Audit history view — `GET /api/admin/audit-logs` *(EXTENDED, slice 001 endpoint)*

- **Permission**: `view_audit_log` (Admin — unchanged)
- **Query** (`auditLogQuerySchema`, EXTENDED): existing `entityType?`, `entityId?`, `action?` **plus new** `actorUserId?`, `from?`, `to?`, `limit?` (default 50, max 200), `offset?`.
- **200** → `{ items: AuditLogView[]; total: number }` where `AuditLogView` adds `actorName` (join `users.name`) to the existing audit columns (§5). Append-only; read-only.
- **Reads**: `audit_logs` (+ `users` join), backed by `audit_logs_{entity,actor,created}_idx`. `from/to` ⇒ `created_at BETWEEN`.
- **Errors**: `401` no session; `403` lacks `view_audit_log` (e.g., non-admin); `400` invalid filter.
- **Unchanged**: the per-trip embedded audit timeline on Trip Detail (`GET /api/trips/:id` → `audit[]`, 005) stays on `view_all_trips`.

---

## 5. Extended read (note, no new endpoint)

- `GET /api/dashboard/summary` (005) is **unchanged in shape**; internally `queryDashboardMetrics` is refactored to source on-time % from the shared `onTimeExpr` (behavior-preserving, R2). No contract change.

---

## Endpoint summary

| Method | Path | Permission | New? |
|---|---|---|---|
| GET | `/api/reports/sla` | `view_all_trips` | NEW |
| GET | `/api/reports/exceptions` | `view_all_trips` | NEW |
| GET | `/api/reports/billing-readiness` | `view_all_trips` | NEW |
| GET | `/api/admin/audit-logs` | `view_audit_log` | EXTENDED (filters + actor join) |
| GET | `/api/dashboard/summary` | `view_all_trips` | unchanged (internal refactor only) |

**4 surfaces touched, 0 mutations, 0 new permission keys, 0 worker jobs.**
