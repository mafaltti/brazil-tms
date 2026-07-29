# Phase 0 Research: Control Tower, Trip List, Trip Detail, and Daily Dashboard

**Feature**: 005-control-tower | **Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)

Design decisions for the read/operating surface over the trip domain. All resolve open choices in the spec and Technical Context; none invent business inputs (Constitution II). Decisions ground in `docs/STACK.md`, the constitution (v1.0.0), the clarified spec (Session 2026-05-30), and the as-built code from slices 001–004. Topics owned by later slices (assignment 006, SLA/exceptions/timeline 007, documents/billing 008) are explicitly excluded (R15).

## R0 — Reuse posture: read-only over 003/004, one write via 003's service

- **Decision**: 005 **consumes** the trip domain read-only and adds **read models** only. The single mutation — operational-field edits (TRIP-005) — calls 003's existing `updateTripPlan(tripId, changes, { authorizedReview }, actorUserId)` unchanged. 005 defines **no** status transitions, billing logic, assignment writes, exception writes, timeline writes, or audit semantics.
- **Rationale**: SPEC-SLICING 005 ("reuses, never redefines"); Constitution I/III. 003 already exposes `listTrips`, `getTrip`, `updateTripPlan`, `billingStatus`, `TRIP_STATUSES`, `TRIP_CRITICAL_FIELDS`; reusing them keeps the status machine, immutable plan, and append-only audit in one place.
- **Alternatives**: A 005-local trip read service duplicating 003's projections (rejected — DRY/Constitution V); a new write path for edits (rejected — would re-implement 003's review gate + audit).

## R1 — Authorization: reuse `view_all_trips` (first enforced in 005), do not add `view_trips`

- **Decision**: Gate all 005 reads (Control Tower list, Trip Detail, dashboard, export) on the **existing** `view_all_trips` permission key, which is already declared in `packages/shared/src/auth/permissions.ts` and already granted to all 7 internal roles — but **never yet enforced**. 005 is the **first slice to enforce it**, and **re-gates** `GET /api/trips` and `GET /api/trips/:id` from `manage_trips` → `view_all_trips` (today those endpoints are reachable only by Admin/Ops Manager, which is why no other role can view trips yet). Operational-field edits keep `manage_trips` (Admin + Ops Manager — the spec's MVP default; the "Limited" Dispatcher/Control-Tower scope is BLOCKED, §18). **No new key is added.**
- **Rationale**: Constitution I (no new key without need) and the exact precedent 004 set by first-enforcing `import_trips`. `view_all_trips` is the semantically correct key (PRD §18 "View all trips" = all internal roles; "View own customer trips" + Customer Viewer are post-MVP). Adding `view_trips` would duplicate `view_all_trips` (Constitution V). **This refines spec FR-034**, which named a "new `view_trips`" key before the catalog was inspected; the spec text is reconciled to `view_all_trips`.
- **Alternatives**: Add a new `view_trips` key as the spec literally said (rejected — duplicates an existing key; violates YAGNI). Keep reads on `manage_trips` (rejected — would block Dispatcher/Control Tower/Fleet/Finance/Executive from viewing, contradicting TRIP-001 + PRD §18).

## R2 — Board read model: enriched server-side query with filter/sort/paginate + total

- **Decision**: Add `queryTripBoard(filters, sort, page)` in `packages/db/src/trips/trips-read.ts` returning `{ rows: TripBoardRow[], total: number }`. It `select`s from `trips` with **inner joins** to `customers`, origin/destination `locations`, and `lanes` so rows carry **display names** (not just IDs), applies all 005-owned filters as a composed `and(...)`, orders by the requested sort (default planned pickup), and paginates with `limit`/`offset`; `total` is a parallel `count()` over the same `where`. The current `listTrips` (status/customerId/q/limit only, returns IDs) is insufficient for the board, so this is a dedicated read model rather than an overload.
- **Rationale**: STACK §6.2 (read models in the BFF) and §3.2 (TanStack Table dense board); the board must show and filter on customer/origin/destination/lane labels. Server-side filter/sort/paginate meets SC-001 (≤3 s) at medium scale with existing + one new index (R5). `offset` pagination is adequate for ≤~10k active rows (cursor deferred — YAGNI).
- **Alternatives**: Extend `listTrips` in place (rejected — diverging shape/joins would complicate the 003 service its tests cover). Client-side filtering/sorting (rejected — STACK §6.2; unacceptable at medium scale). A Postgres materialized view (rejected — YAGNI at medium scale; revisit only near option-C volume).

## R3 — Filter dimensions actually built (clarified option B)

- **Decision**: 005 builds the **eight data-backed filters**: customer, **date** (= planned pickup window range), status (multi-select over `current_status`), origin, destination, lane, vehicle type, and **billing status** (mapped to `current_status ∈ {billing_pending, billing_ready, billed, disputed}` via a `shared` helper — no stored column). It builds a **forward-compatible filter framework** but **no controls** for assigned driver/vehicle/carrier (→ 006) or SLA risk (→ 007). Filters combine with **AND**; the persistent search matches external trip ID / customer / lane.
- **Rationale**: Spec clarification (option B) + SPEC-SLICING (006/007 add their filters/indicators into the Control Tower). Billing status is 003's derived projection (R0). "Date" maps to planned pickup window because that is the operational date driving the board and the Today/Next-24h views.
- **Alternatives**: Disabled placeholder controls for the four later-slice dims (rejected — option A, dead UI, YAGNI). "Date" = created-at (rejected — created-at is intake bookkeeping, not the operational date dispatchers reason about).

## R4 — Default landing scope + "active" status set

- **Decision**: With no view/filter selected, the board defaults to **active/open trips** — `current_status ∈ {received, validation_error, validated, assigned, confirmed, at_origin, loading, loaded, in_transit, at_destination, unloading, unloaded}` (excludes `completed`, `billing_pending`, `billing_ready`, `billed`, `cancelled`, `disputed`), ordered by planned pickup. This set is exported from `packages/shared/src/domain/trip-status.ts` as `ACTIVE_TRIP_STATUSES` with an `isActiveStatus(s)` helper, reused by the board default, the (implicit) "active" filter, and dashboard counts.
- **Rationale**: Spec clarification (option B landing). A control tower monitors in-flight work; defaulting to active bounds the default result set at medium scale (perf) and matches the operating mental model. Centralizing the set in `shared` avoids three divergent literal lists (DRY).
- **Alternatives**: Default to "all trips" (rejected — loads history needlessly) or to "Today" (rejected — hides multi-day in-transit trips). Per-user remembered view (rejected — needs persistence; YAGNI for MVP).

## R5 — Indexing for date/board queries

- **Decision**: Add **one** index `trips_pickup_start_idx` on `trips(planned_pickup_window_start)`. Existing indexes (`trips_customer_idx`, `trips_status_idx`, `trips_created_idx`, `trips_customer_external_id_uq`) already cover customer/status/search filters and recency ordering; the new index supports date-range filters, Today/Next-24h views, the default active ordering, and the "trips today" dashboard counts.
- **Rationale**: SC-001 (≤3 s) at medium scale. Postgres composes the single-column indexes for AND-filters; partial/composite indexes are deferred until profiling shows a need (YAGNI, Constitution I).
- **Alternatives**: A composite `(current_status, planned_pickup_window_start)` index (deferred — not justified before profiling). No new index (rejected — date range and Today views would seq-scan).

## R6 — "Date" boundaries in `America/Sao_Paulo`

- **Decision**: "Today" / "Next 24 hours" and the "trips today by status" widget compute day boundaries in **`America/Sao_Paulo`** with Luxon, then convert to UTC instants for the query (`planned_pickup_window_start` is stored UTC). Reuse `@brazil-tms/shared` Luxon helpers; add a small `dayRangeSaoPaulo(date)` util if not present.
- **Rationale**: SPEC-SLICING global constraint (UTC stored / America/Sao_Paulo displayed); FR-032. Computing boundaries in the business timezone avoids off-by-one-day bugs near midnight.
- **Alternatives**: Compare on the server's local/UTC date (rejected — wrong day near midnight BRT). `date_trunc` in SQL at UTC (rejected — same timezone bug).

## R7 — Freshness: per-surface polling intervals (no Realtime)

- **Decision**: Freshness is **polling via TanStack Query** with `refetchInterval` per surface — **Control Tower 30 s, Home Dashboard 60 s, Trip Detail 30 s** — exported as named constants in `apps/web/lib/trips/client.ts` (configurable). The QueryClient default `staleTime` is already 30 s; intervals are set per `useQuery`. No `refetchInterval` is added to global defaults.
- **Rationale**: STACK §3.3/§3.10 (polling-only, tune per surface) + spec clarification. 30 s keeps the active board fresh without being chatty at medium scale with many concurrent users; the overview dashboard tolerates 60 s.
- **Alternatives**: Realtime/websockets (**excluded by constitution**). Uniform interval (rejected — wastes load on the slow dashboard). 15 s board (rejected — heavier load, no clear benefit at medium scale).

## R8 — URL-encoded filter/view state (no new dependency)

- **Decision**: The board reflects active filters / search / view / sort / page in the **URL search params**, parsed and serialized through the trip-board Zod schema with `useSearchParams` + `useRouter().replace`. Default views (R9) are presets that set those params; the URL is the single source of truth, making any view shareable and reload-safe (FR-005).
- **Rationale**: FR-005; KISS — no `nuqs`/router-state library is in the repo and none is warranted (Constitution I). Zod gives one validated parse for both the URL and the BFF query.
- **Alternatives**: `nuqs` or a client store (rejected — new dependency / state to keep in sync; YAGNI). Server-component-only filters (rejected — polling + interactive filtering need a client query layer).

## R9 — Default views: ship only data-backed presets via a view framework

- **Decision**: Ship the **data-backed** presets — **Today, Next 24 hours, In transit, Billing pending** — as selectable, deep-linkable filter presets defined in one config array consumed by the board. Provide a **view-registry shape** so 006/007/008 can register **Unassigned** (006), **At risk** (007), and **Missing documents** (008) when their data lands. **No** non-functional presets ship in 005. User-defined persisted views are deferred (YAGNI).
- **Rationale**: Spec clarification (option B saved-views) + §15.4. A view is just a named set of URL params (R8) — trivial, no persistence.
- **Alternatives**: Ship all seven §15.4 views now (rejected — three can't be populated → dead UI). Persisted per-user views (rejected — YAGNI; the exact role→view mapping is BLOCKED, §15.4).

## R10 — Trip Detail composition + placeholder sections

- **Decision**: `getTripDetailView(id)` wraps 003's `loadTripDetail` (trip row + latest 50 `trip_events` + latest 50 `trip` `audit_logs`) and adds **name enrichment** (customer, origin/destination, lane) and the `import_batch_id` reference. The page renders the §15.5 sections: **Header** (customer, trip ID, lane, status, SLA risk, billing status), **Customer plan** (immutable `original_plan` alongside live `planned_*` + recorded actual milestone timestamps from `trip_events`), **Timeline** (read-only events), **Notes**, **Audit history** (read-only, mapped `trip.*` actions) — all populated now — plus **Assignment / Exceptions / Documents / Billing** as labelled **placeholder sections** (owned by 006/007/008). SLA risk shows 007's `sla_status` placeholder.
- **Rationale**: TRIP-003/004, §15.5, and SPEC-SLICING 005 exit criteria (which explicitly endorse placeholder *sections* on Trip Detail, distinct from the option-B "no dead controls" rule for board filters). 003 already returns events + audit; only enrichment is new.
- **Alternatives**: Hide later-slice sections until their slice ships (rejected — exit criteria require the full section structure now). Re-query events/audit independently (rejected — `loadTripDetail` already returns them).

## R11 — Operational-field edit: reuse `updateTripPlan` + a BFF "before completion" guard

- **Decision**: `PATCH /api/trips/:id/plan` validates a partial of the 10 live `PLAN_FIELDS` (Zod), requires `manage_trips`, and calls `updateTripPlan(id, changes, { authorizedReview }, ctx.userId)`. 003's service already preserves the immutable plan, audits critical-field changes (`trip.plan_update`), and enforces the post-`confirmed` `REVIEW_REQUIRED` gate. 005 **adds the "before completion" hard-block**: the route rejects with `409 EDIT_NOT_ALLOWED` when `current_status ∈ {completed, billing_pending, billing_ready, billed, cancelled, disputed}` (TRIP-005 "before completion"). Conflicts surface 003's codes (`REVIEW_REQUIRED`, `STALE_TRANSITION`) as localized messages.
- **Rationale**: TRIP-005 + Constitution III. 003's `updateTripPlan` allows post-`confirmed` edits *with review* but does **not** block completed/terminal; the "before completion" rule is a 005 policy, so the thin guard lives in 005's route (not a redefinition of 003). The pre-read status vs the `SELECT … FOR UPDATE` inside `updateTripPlan` admits a rare benign race (a trip completing exactly during an edit) — acceptable for MVP and still audited; the guard can migrate into the domain service later if it recurs in 006/007.
- **Alternatives**: Extend `updateTripPlan` to hard-block terminal statuses (rejected for now — modifies 003's service that other slices depend on; revisit if ≥2 more callers need it). Enforce only in the client (rejected — Constitution III/IV).

## R12 — Dashboard metrics: compute what exists, return `null` for later-slice widgets

- **Decision**: `GET /api/dashboard/summary` (gated `view_all_trips`) returns all eight §15.2 widgets via `queryDashboardMetrics()`. **Computed now**: *trips today by status* (group `current_status` where pickup window is today in BRT) and *billing pending count* (`current_status = billing_pending`). **Returned `null`** (UI renders a labelled placeholder): trips at risk + on-time pickup/arrival % (007), unassigned trips (006), active exceptions (007), completed-missing-documents (008). Each non-null widget carries the filter params to **deep-link** into the Control Tower (FR-030).
- **Rationale**: REP-001/§15.2, owned wholly by 005 (no later slice adds dashboard widgets — distinct from board filters), so 005 builds the full widget shell with placeholder/zero-state and invents nothing (Constitution II).
- **Alternatives**: Omit later-slice widgets until their data exists (rejected — REP-001 requires the dashboard answer "what needs attention today" with the full widget set). Fabricate plausible SLA/at-risk numbers (rejected — Constitution II).

## R13 — CSV export: synchronous, in-handler, capped, no new dependency

- **Decision**: `GET /api/trips/export` (gated `view_all_trips`) reuses the board `where`/sort via `exportTripRows(filters, cap)`, builds **CSV** as a string with a **UTF-8 BOM** (so Excel renders pt-BR accents) and the board's visible columns, and returns `200 text/csv` with `Content-Disposition: attachment`. A **row cap of 10,000** bounds it; if the filtered set exceeds the cap it returns `422 EXPORT_TOO_LARGE` prompting narrower filters (**no silent truncation**). No CSV library is added (the repo has none; `exceljs` is worker-only).
- **Rationale**: REP-005 + spec clarification (synchronous capped CSV; XLSX/worker export → 008). A capped filtered CSV is bounded, so it does not violate "no heavy work in handlers." The 10,000 cap aligns with the medium-scale active set; the value is a documented default pending Ops confirmation.
- **Alternatives**: Worker-generated export with a signed URL like 004's XLSX error report (rejected — that pipeline is 008's; over-engineered for a bounded filtered list). XLSX via `exceljs` in the handler (rejected — heavier dep + memory; CSV suffices). No cap (rejected — unbounded handler work).

## R14 — Status display, i18n, and formatting

- **Decision**: Add pt-BR strings under a new `Trips`/`ControlTower` message namespace: trip-status labels (18) + billing-status labels, board column headers, filter labels, default-view names, Trip Detail section titles, dashboard widget titles, and `trip.*` audit-action labels. Add a `TripStatusBadge` (pt-BR label + accessible status colour) following the master-data status-badge pattern. Format all timestamps with the shared `formatDate`/`formatDateTime` (`America/Sao_Paulo`).
- **Rationale**: FR-035/§21.6/§16 (clear status colours, accessible contrast); DRY (reuse shared formatting + existing badge pattern). pt-BR currently lacks trip-status strings (only import statuses exist).
- **Alternatives**: Inline status strings/colours per component (rejected — duplication; DRY). Client-side `Intl.DateTimeFormat` one-offs (rejected — the shared Luxon helpers are canonical).

## R15 — What is explicitly NOT built (scope guard, Constitution II)

- **Decision**: 005 does **not** build: assignment data/filters/indicators/panel writes or the "Unassigned" view (006); exception creation, interactive timeline/event writing, SLA computation/recalculation, SLA-risk filter/indicator, "At risk" view, on-time metrics (007); document upload/review, billing items/rates/readiness reasons, the "Missing documents" view, XLSX/worker export, billing export format (008); advanced reports REP-002/003/004 (009); bulk update TRIP-008 (Later); status transitions or any new trip-write path; customer-scoped row visibility / Customer Viewer (post-MVP); user-defined persisted saved views (YAGNI). SLA, document, and billing **values** are never invented — the seven BLOCKED items (spec §"Blocked / Open for business sign-off") are scaffolded with labelled documented defaults.
- **Rationale**: SPEC-SLICING 005 boundaries + Constitution I/II. Each item has an owning slice or a business-input gate (PRD §29).
- **Alternatives**: Pre-build any of the above "while we're here" (rejected — scope creep the team cannot absorb; Constitution II).
