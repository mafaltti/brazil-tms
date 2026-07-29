# Data Model — 009 Reporting, Audit Views, Hardening, and MVP Acceptance

**This slice adds NO new tables, enums, columns, or migrations.** It is **read-only** over the existing schema. This document specifies (1) the **read-model projection shapes** the three reports return, (2) the shared `onTimeExpr` predicate, (3) the **audit-view read extension**, (4) the **reused tables/columns/indexes** each report depends on, and (5) the no-migration decision and its contingency. Monetary values are integer **centavos (BRL)**; timestamps are stored **UTC** and rendered in `America/Sao_Paulo`; ISO strings cross the BFF boundary (matching the existing read models).

---

## 0. DDL summary

| Change | Count |
|---|---|
| New tables | **0** |
| New enums | **0** |
| New columns / `trips` ALTER | **0** |
| New migration (default build) | **0** (contingent `0008` indexes only if a measured query misses the §21.2 budget — research R6) |
| New permission keys | **0** (reports → `view_all_trips`; audit → `view_audit_log`; admin → `manage_commercial_data`) |
| New read-model functions | **3** report projections + **1** shared predicate + **1** extended audit read |

The §14.1 conceptual entities listed in the spec's *Key Entities* are **read models / queries**, not stored entities.

---

## 1. `onTimeExpr` — shared on-time predicate (DRY-for-correctness, clarify Q4)

`packages/db/src/trips/on-time.ts` — a Drizzle SQL fragment factory consumed by **both** `queryDashboardMetrics` (behavior-preserving refactor) and `querySlaReport`. Single source of truth so the dashboard and the SLA report can never diverge (FR-006).

```text
onTimeExpr(kind: "pickup" | "arrival"): { actualRecorded: SQL<boolean>, onTime: SQL<boolean> }

pickup:   actualRecorded = trip has a trip_events row with status_after = 'at_origin'
          onTime         = that event's timestamp <= trips.planned_pickup_window_end
arrival:  actualRecorded = trip has a trip_events row with status_after = 'at_destination'
          onTime         = that event's timestamp <= trips.planned_delivery_window_end

on-time %  = count(onTime) / count(actualRecorded) * 100        -- NULL when denominator = 0
```

- "event's timestamp" = `trip_events.event_timestamp` falling back to `created_at` when null (the existing dashboard rule).
- Reads only existing `trips` + `trip_events` columns; introduces no new column.

---

## 2. SLA Performance read model (SLA-005, REP-002, US1)

`querySlaReport(filters: ReportFilter): Promise<SlaReport>` — `packages/db/src/trips/reporting.ts`.

**Input** `ReportFilter` (Zod `reportFilterSchema`, `@brazil-tms/shared`):
```text
{ customerId?: uuid, laneId?: uuid, from?: ISODate, to?: ISODate,
  groupBy?: "customer" | "lane" (default "customer") }
period default: last completed calendar month in America/Sao_Paulo (defaultReportPeriod)
```

**Output** `SlaReport`:
```text
{
  period:    { from: ISODate, to: ISODate, label: string },   // e.g. "maio/2026"
  provisional: boolean,                                        // true if any included customer lacks customer_sla_rules (R8)
  provisionalReason?: string,                                  // "pendente de regras de SLA do cliente"
  totals:    SlaReportTotals,                                  // ungrouped figures for the summary cards
  groups: SlaReportRow[]
}

SlaReportRow / SlaReportTotals {
  // (SlaReportRow adds groupKey: uuid (customerId|laneId) + groupLabel: string)
  total: int,
  onTimePickupPct: number | null,     // via onTimeExpr("pickup") — the period performance headline (SC-001)
  onTimeArrivalPct: number | null,    // via onTimeExpr("arrival")
  onTrack: int, atRisk: int, late: int, breached: int,  // counts grouped from the STORED trips.sla_status
  settled: int                        // trips with sla_status IS NULL (closed — 007 clears the live state)
}
// Reconciliation: onTrack + atRisk + late + breached + settled = total.
```

- **Reads**: `trips` (`customer_id`, `lane_id`, `sla_status`, `planned_pickup_window_*`, `planned_delivery_window_*`), `trip_events` (via `onTimeExpr`), `customers`/`lanes` (labels), `customer_sla_rules` (existence → `provisional`). Excludes `cancelled`/archived trips.
- **Period membership**: by `planned_pickup_window_start` date within `[from,to]` (R3). Grouped by customer (default) or lane.
- **SLA state counts**: grouped from the stored `trips.sla_status` ∈ `{on_track, at_risk, late, breached}` (007) — **never re-derived in this slice** (Constitution III). Because 007 **clears `sla_status` when a trip leaves the active set** (`sla.ts`), closed trips carry `NULL` and are counted under **`settled`** (so the four risk states never silently swallow a closed trip; a historical-period report's risk states reflect the still-open trips, while the on-time %s give the period performance).

---

## 3. Exception Analytics read model (REP-003, US2)

`queryExceptionReport(filters: ReportFilter): Promise<ExceptionReport>`.

**Output** `ExceptionReport`:
```text
{
  period: { from, to, label },
  totals: { total: int, open: int, resolved: int, avgResolutionMinutes: number | null },
  byCategory: { category: ReasonCodeCategory, count: int }[],   // the 12 §13.8 categories
  bySeverity: { severity: "low"|"medium"|"high", count: int }[],
  groups: { groupKey, groupLabel, total, open, resolved }[]      // by customer (default) or lane
}
```

- **Reads**: `exceptions` (`trip_id`, `reason_code_id`, `severity`, `status`, `opened_at`, `resolved_at`), `reason_codes` (`category`, `labelPt`), joined to `trips`→`customers`/`lanes` for grouping. Reuses 007's `queryExceptions` join shape.
- **Period membership**: by `exceptions.opened_at` within `[from,to]` (R3).
- **Open / resolved**: `status ∈ {open, monitoring}` = open; `status = 'resolved'` = resolved. **Avg resolution time** = `avg(resolved_at − opened_at)` over resolved exceptions in the period (§9.1).
- **Delay-reason breakdown** = volume grouped by `reason_codes.category`.

---

## 4. Billing Readiness read model (REP-004, US3)

`queryBillingReadinessReport(filters: ReportFilter): Promise<BillingReadinessReport>`.

**Output** `BillingReadinessReport`:
```text
{
  period: { from, to, label },
  provisional: boolean,            // true when per-customer document/billing rules unsupplied (default checklist/manual values, R8)
  provisionalReason?: string,      // "pendente de regras de cobrança/documentos"
  phaseCounts: { billing_pending: int, billing_ready: int, billed: int, disputed: int },  // via billingStatus(current_status)
  completedMissingDocuments: int,  // reuse 008 signal
  pctReadyWithin24h: number | null,// completion→billing_ready gap ≤ 24h (R4)
  groups: { groupKey, groupLabel, billing_pending, billing_ready, billed, disputed }[]     // by customer
}
```

- **Reads**: `trips` (`current_status` → `billingStatus` projection; completion via `trip_events`), `billing_items` (`customer_id`, `billing_period`, `has-missing-proof`/`hasMissingProof`), `trip_events` (`status_after ∈ {completed, billing_ready}` for the 24h gap), `customers` (labels). Reuses 003's `billingStatus(current_status)` projection and 008's `queryBillingList` `hasMissingProof`.
- **Period membership**: by `billing_items.billing_period` (month of completion, 008) filtered by customer (R3).
- **`pctReadyWithin24h`**: among trips completed in the period, the share whose `billing_ready` event minus `completed` event ≤ 24h (clarify Q3 / R4). Null when no completed trips in the period.
- **`provisional`** flag set when the included customers rely on the `DEFAULT_DOCUMENT_CHECKLIST` / manual billing values (no per-customer rules) — surfaces the blocked sign-off (R8).

---

## 5. Audit-view read extension (FR-013/014, US4)

`queryAuditLog(filters): Promise<{ items: AuditLogView[]; total: int }>` — `packages/db/src/audit/audit-read.ts`, behind `GET /api/admin/audit-logs` (`view_audit_log`).

**Extends** the existing slice-001 read with **new filters** and an **actor-name / entity-label join**:
```text
filters: {
  entityType?: string, entityId?: uuid, action?: string,   // existing
  actorUserId?: uuid,  from?: ISODate, to?: ISODate,        // NEW
  limit?: int (default 50, max 200), offset?: int           // NEW (pagination)
}

AuditLogView {                                              // existing columns + joins
  id, entityType, entityId, action, previousValue, newValue,
  actorUserId, actorName,         // NEW: join users.name
  reason, createdAt
}
```

- **Reads only** `audit_logs` (+ a `users` join for `actorName`); append-only, never mutated (Constitution III). No new column.
- **Existing indexes suffice**: `audit_logs_entity_idx (entity_type, entity_id)`, `audit_logs_actor_idx (actor_user_id)`, `audit_logs_created_idx (created_at DESC)` back the entity/actor/date-range filters. `from`/`to` are **São Paulo calendar-day strings** (`YYYY-MM-DD`), resolved to a half-open BRT day range via `dayRangeSaoPaulo` (`to` **inclusive** of its day) — the same convention the reports use, so a date-only filter never excludes that day's records or drifts by the UTC offset. The screen also exposes `entityType` (presets) + a specific `entityId`, `action`, and `actorUserId`, with offset pagination (no client-side row cap).
- The **§21.5 record coverage** (status changes, assignment changes, document verification, billing changes, export-batch history) is presentation: the screen offers entity-type/action presets over the actions slices 001–008 already write (`trip.status_change`, `trip.assign/reassign/unassign`, `document.verify`, `billing_item.update`, `billing.export`, etc.). The **embedded per-trip timeline** (`loadTripDetail` → `audit: AuditEntryDto[]`, 005) is unchanged and stays on `view_all_trips`.

---

## 6. Reused tables, columns & indexes (read dependencies)

| Table | Columns read | Existing indexes used | Owner |
|---|---|---|---|
| `trips` | `customer_id`, `lane_id`, `current_status`, `sla_status`, `sla_reasons`, `planned_pickup_window_*`, `planned_delivery_window_*` | `trips_customer_idx`, `trips_pickup_start_idx`, `trips_status_idx` | 003/005/007 |
| `trip_events` | `trip_id`, `status_after`, `event_timestamp`, `created_at` | `trip_events_trip_idx`, `trip_events_type_idx` | 003/007 |
| `exceptions` | `trip_id`, `reason_code_id`, `severity`, `status`, `opened_at`, `resolved_at` | `exceptions_{status,severity,reason,opened}_idx` | 007 |
| `reason_codes` | `id`, `category`, `labelPt` | PK | 007 |
| `customer_sla_rules` | `customer_id` (existence → provisional) | (existence check) | 007 |
| `billing_items` | `customer_id`, `billing_period`, `trip_id`, missing-proof flag | `billing_items_customer_period_idx`, `billing_items_trip_uq` | 008 |
| `customers` / `lanes` | labels (`name`, origin/destination codes) | PK / FK | 002 |
| `audit_logs` | all columns (+ `users.name` join) | `audit_logs_{entity,actor,created}_idx` | 001 |

**Derived, not stored**: `billingStatus(current_status)` (003 projection), on-time % (`onTimeExpr`), avg resolution time, `pctReadyWithin24h`, the `provisional` flags.

---

## 7. No-migration decision (research R6)

The default build ships **no migration**. The rollups filter by `customer_id` + a date window and group by `lane_id` / `sla_status` / `current_status` — covered by the existing single-column indexes at MVP volume (a customer-month slice is hundreds of rows). Adding composite indexes speculatively violates YAGNI (Constitution I).

**Contingency** (only if the FR-019 performance validation measures a report over the §21.2 ~3 s budget): migration `0008_*.sql` adding the **narrowest** fix — first candidates `trips(customer_id, planned_pickup_window_start)` (SLA rollup) and/or `trips(customer_id, current_status)` (billing-phase rollup). Any added index is logged (no silent scope; SC documentation).

---

## 8. Validation rules (from the spec)

- **R-VAL-1**: A report filtered to a selection with no matching rows returns an explicit empty result (`groups: []`, counts 0), never an error (spec Edge Cases).
- **R-VAL-2**: `provisional` MUST be `true` whenever an included customer relies on default SLA / document-billing rules; the UI MUST render the provisional banner (FR-007/FR-012; never present provisional figures as final).
- **R-VAL-3**: A trip is counted in **exactly one period per report** per the report-specific membership date (R3).
- **R-VAL-4**: Reports are **read-only** — no code path mutates a row or writes an audit record when a report or the audit view is read (Constitution III/IV).
- **R-VAL-5**: SLA-state counts come from the stored `trips.sla_status` and on-time % from `onTimeExpr` — the slice **never re-derives** SLA classification (Constitution III / STACK §6.1).
- **R-VAL-6**: The audit view never returns soft-deleted-record gaps — archived operational records are excluded from operational *counts* but their audit rows remain visible (history never hidden).
