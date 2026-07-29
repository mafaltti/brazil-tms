# Implementation Plan: Control Tower, Trip List, Trip Detail, and Daily Dashboard

**Branch**: `005-control-tower` | **Date**: 2026-05-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-control-tower/spec.md`

## Summary

This slice builds the **operating surface** over the existing trip domain: a dense **Trip Control Tower** list (server-side search / filter / sort / pagination), a **Trip Detail** page composing the full single-trip record, a **Home (daily) Dashboard** that answers "what needs attention today?", a synchronous **CSV export** of the filtered list, and **inline editing of live planned fields before completion**. It is deliberately read-first: every screen reads through the BFF and refreshes by **polling via TanStack Query** (no Realtime), and the slice introduces **no new tables, no new package, no worker job**.

Technical approach: 005 **consumes 003/004 read-only** and adds new **read models** in `@brazil-tms/db` (board list with name enrichment + filter/sort/paginate + total count; detail view; dashboard aggregates; export rows) plus `view_all_trips`-gated BFF endpoints. The **single write** — operational-field edits (TRIP-005) — **reuses 003's `updateTripPlan`** unchanged (immutable original plan, post-`confirmed` `REVIEW_REQUIRED` gate, `trip.plan_update` audit), with a thin BFF guard adding the "before completion" hard-block. Authorization reuses the **already-declared `view_all_trips`** key (granted to all 7 internal roles in 001's catalog but never yet enforced); 005 is the **first slice to enforce it** — exactly the pattern 004 used for `import_trips` — and re-gates the read endpoints from `manage_trips` → `view_all_trips` so Dispatcher / Control Tower / Fleet / Finance / Executive can view (edits stay on `manage_trips`). Per the clarified spec (option B), the four TRIP-002 dimensions owned by later slices (assigned driver/vehicle/carrier → 006; SLA risk → 007) are **not built here**; 005 ships a forward-compatible filter/indicator/view framework that 006/007 extend. Documents/billing detail (008) and SLA/exceptions (007) appear on Trip Detail as labelled placeholder **sections**, and the Home Dashboard builds all eight §15.2 widgets with placeholder/zero-state for later-slice metrics (it owns REP-001 wholly). No customer/SLA/document/billing values are invented (Constitution II).

## Technical Context

**Language/Version**: TypeScript 5.6 (strict); Node.js 20 LTS; pnpm 10 monorepo.

**Primary Dependencies** (existing — no new runtime deps): Next.js 15 (App Router) + React 19; Drizzle ORM over `postgres` (server-only); Zod 3.23 (filter/sort/pagination + plan-edit input validation, shared by web); Luxon 3 (`America/Sao_Paulo` day boundaries for "Today"/dashboard); **TanStack Query 5** (per-surface polling) + **TanStack Table 8** (dense board); `next-intl` (pt-BR); shadcn/ui + Radix + lucide-react. **CSV export is built in the route handler** (plain string + UTF-8 BOM) — no `papaparse`/`json2csv`/`exceljs` added (Constitution I).

**Storage**: self-hosted Supabase Postgres. **No new tables, no new enums.** One **new index** `trips_pickup_start_idx` on `trips(planned_pickup_window_start)` to back date-range filters, the "Today"/"Next 24h" views, and active-trip ordering. New **read models** (Drizzle `select` + joins) over existing `trips`, `trip_events`, `audit_logs`, `customers`, `locations`, `lanes`. The sole write reuses 003's `updateTripPlan` (writes `trips` + `audit_logs`). **No Supabase Storage** use (CSV streamed from the handler, never stored); PostgREST/gateway never exposed.

**Testing**: Vitest is the primary gate. **Pure unit** (`packages/shared`): `ACTIVE_TRIP_STATUSES`/`isActiveStatus`, billing-status→`current_status` filter mapping, the trip-board Zod schema (filter/sort/pagination/export bounds), and permission invariants for `view_all_trips`. **Service/integration** (`apps/web` lib, dev DB, `describe.skipIf(!DATABASE_URL)`): board read model — each filter, AND-combination, sort, pagination + correct `total`; active/open default scope; detail view name enrichment + events + audit; dashboard metrics (trips-today-by-status, billing-pending count) with later-slice metrics returned `null`; export rows + **over-cap → error** (no silent truncation); plan edit — happy path + **completed/terminal hard-block** + post-`confirmed` `REVIEW_REQUIRED` + `manage_trips` permission; read endpoints gated `view_all_trips` (`401`/`403`). **Playwright**: Control Tower (view → search → filter → default view → export), Trip Detail (all §15.5 sections incl. placeholders → edit before completion → authz), Home Dashboard (widgets → one-click deep-link), and read-access authz for the new roles.

**Target Platform**: Linux server via Docker Compose (Supabase, app, worker, Caddy). Desktop-first, evergreen browsers (PRD §16). **No worker work in this slice** — the export is synchronous and bounded in the BFF.

**Project Type**: Web application — existing monorepo (`apps/web` + `packages/{shared,db}`). **No new package, no worker job.**

**Performance Goals**: Trip list returns within **3 s** for common filters at the medium design scale (≤ ~10k active trips) via **server-side pagination + indexed filters** (SC-001); Trip detail within **2 s** (SC-003). Polling tuned per surface — **Control Tower 30 s, Home Dashboard 60 s, Trip Detail 30 s** (configurable; TanStack Query `refetchInterval`). CSV export is synchronous, capped at **10,000 rows** (over-cap prompts narrower filters).

**Constraints**: BFF-only authorization; service-role key server-only; gateway/PostgREST never public; **NO** Realtime / Edge Functions / Redis-BullMQ / microservices / route optimizer; freshness via **polling**; reads served by BFF read models (no heavy work in handlers — export is bounded/capped); **read-only consumption of 003/004** — the sole write **reuses 003's `updateTripPlan`** and does **not** redefine the status machine, billing projection, or audit; original plan immutable; audit append-only; status shown **read-only** (transitions owned by 006/007); UI pt-BR; timestamps UTC (displayed `America/Sao_Paulo`); currency BRL.

**Scale/Scope**: **0** new tables; **0** new enums; **1** new index (`trips_pickup_start_idx`); **0** new permission keys — **reuse `view_all_trips`, FIRST ENFORCED in 005** (re-gates `GET /api/trips` + `GET /api/trips/:id` from `manage_trips` → `view_all_trips`; plan edit keeps `manage_trips`); **~5 BFF endpoints** (2 extended: list + detail; 3 new: `PATCH …/plan`, `GET …/export`, `GET /api/dashboard/summary`); **3 screens** (Control Tower, Trip Detail, Home Dashboard) + components; **4 read-model query functions** in `@brazil-tms/db` (board / detail-view / dashboard / export) re-exported server-only; a trip-board Zod schema + an active-status domain helper in `shared`; pt-BR strings + a trip-status badge. **Seven items remain BLOCKED** on business inputs / upstream slices (SLA-risk thresholds → §29 #2 / 007; assigned driver/vehicle/carrier dims → 006; billing detail & export format → 008 / §29 #4–5; document statuses → 008 / §29 #3; "Limited" edit scope → §18; saved-views-by-role mapping → §15.4; export-cap value confirmation) — scaffolded with documented defaults, **not** invented (Constitution II).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Confirmed against `.specify/memory/constitution.md` (v1.0.0):

- [x] **Simplicity (I)**: Read-first slice that **reuses** 003/004 — **no new package, no worker, no new permission key** (reuse `view_all_trips`), **no new table/enum**. CSV is built in the handler (no new library); **server-side pagination** is used so **no virtualization library** is added (YAGNI). Per clarified option B, the four later-slice filter dimensions are **not** built as dead/disabled controls. No abstraction is introduced below the ≥3 rule (the four read-model queries are concrete, not a generic query framework).
- [x] **Scope (II)**: Strictly TRIP-001..005 + REP-001/REP-005 (SPEC-SLICING 005). Assignment (006), exceptions/timeline/SLA (007), documents/billing detail & export (008), advanced reports (009), and bulk update (Later) are out of scope; Trip Detail shows labelled **placeholder sections** for them. SLA/assignment/document/billing values are **not invented** — seven items are explicitly BLOCKED and labelled.
- [x] **System-of-record (III)**: All durable state stays in Postgres. The slice is read-only except operational-field edits, which **reuse 003's `updateTripPlan`** — the immutable original plan, the explicit status machine, and the append-only `trip.plan_update` audit are untouched. Status is displayed **read-only**; 005 performs no transitions, assignments, or billing actions. No client owns authority.
- [x] **Authz & secrets (IV)**: Every screen reads through the **BFF**; reads enforce `view_all_trips`, the plan edit enforces `manage_trips` — both via `requirePermission` (RLS deferred). Service-role key stays server-only; gateway never exposed. The sole sensitive action (plan edit) is audited by 003.
- [x] **Config over code (V)**: No per-customer code. Customer variation surfaces only as data (customer/lane/location names from 002) and as i18n labels; status display is a config map, not branching logic.
- [x] **Tech constraints**: Freshness is **polling-only** (TanStack Query `refetchInterval`); **no Realtime, no Edge Functions, no Redis/BullMQ, no microservices, no route optimizer**. One app, no worker activation. Reads are BFF read models; the export is bounded/capped so no heavy work runs in a handler.
- [x] **Workflow**: Short-lived `005-control-tower` branch → PR to **`dev`**; CI gates (lint/typecheck/build/tests) must pass; PR template used; AI does not merge to `main`.

**Result: PASS.** No violations; **Complexity Tracking is therefore empty.** (Reusing the pre-declared `view_all_trips` key and re-gating the read endpoints is the constitutionally-preferred DRY/YAGNI choice over adding a new key — it mirrors 004's first-enforcement of `import_trips`.)

## Project Structure

### Documentation (this feature)

```text
specs/005-control-tower/
├── plan.md                       # This file (/speckit-plan output)
├── research.md                   # Phase 0 — design decisions (R0–R15)
├── data-model.md                 # Phase 1 — read models, new index, reused tables, Zod, no new tables
├── quickstart.md                 # Phase 1 — setup, run, US-by-US verification, tests
├── contracts/
│   ├── bff-endpoints.md          # list (extended) · detail (extended) · plan-edit · export · dashboard
│   └── permission-matrix.md      # no new key — first enforcement of view_all_trips
├── spec.md                       # Feature spec (/speckit-specify + /speckit-clarify)
├── checklists/requirements.md    # Spec quality checklist
└── tasks.md                      # Phase 2 — /speckit-tasks (NOT created by /speckit-plan)
```

### Source Code (repository root) — extends the existing monorepo

```text
packages/shared/src/
├── domain/trip-status.ts                 # EXTEND: + ACTIVE_TRIP_STATUSES, isActiveStatus, billingStatusToStatuses()
├── schemas/trip-board.ts                 # NEW: Zod — board filter/sort/pagination + export query + plan-edit input
└── auth/permissions.ts                   # UNCHANGED: reuse existing view_all_trips (no new key)

packages/db/
├── schema/trips.ts                       # EXTEND: + trips_pickup_start_idx
├── migrations/                           # NEW: drizzle migration adding the index
└── src/
    ├── trips/trips-read.ts               # NEW: queryTripBoard / getTripDetailView / queryDashboardMetrics / exportTripRows
    └── index.ts                          # EXTEND: export the new read-model functions

apps/web/
├── lib/
│   ├── trips/trips-read.ts               # NEW: server-only re-export of the @brazil-tms/db read models
│   └── trips/client.ts                   # NEW: client query hooks (useTripBoard/Detail/Dashboard/UpdatePlan) + poll intervals + URL filter state
├── app/api/
│   ├── trips/route.ts                    # EXTEND: re-gate → view_all_trips; full filter/sort/pagination; enriched rows + total
│   ├── trips/[id]/route.ts               # EXTEND: re-gate → view_all_trips; enriched detail view
│   ├── trips/[id]/plan/route.ts          # NEW: PATCH plan edit (manage_trips + before-completion guard → reuse updateTripPlan)
│   ├── trips/export/route.ts             # NEW: GET CSV export (view_all_trips; capped 10k)
│   └── dashboard/summary/route.ts        # NEW: GET daily-dashboard metrics (view_all_trips)
├── app/(shell)/
│   ├── page.tsx                          # EXTEND: Home (daily) Dashboard widgets + deep-links
│   └── trips/
│       ├── page.tsx                      # NEW: Trip Control Tower (server guard → client board)
│       └── [id]/page.tsx                 # NEW: Trip Detail (server guard → client detail)
├── components/trips/                     # NEW: control-tower-table, trip-filters, default-views, trip-status-badge,
│                                         #      detail sections (header/plan/assignment*/timeline/exceptions*/documents*/billing*/notes/audit),
│                                         #      plan-edit form, dashboard widgets   (* = placeholder section)
├── lib/nav.ts                            # EXTEND: + Trips / Control Tower nav (gated view_all_trips)
└── messages/pt-BR.json                   # EXTEND: trip statuses, board/filter/detail/dashboard labels, trip.* audit actions
```

**Structure Decision**: Web application on the existing monorepo. Read-model **queries** live in `@brazil-tms/db` (`trips-read.ts`) beside 003's `trips-service.ts` and are re-exported server-only through `apps/web/lib/trips/`, matching how 003/004 expose `listTrips`/`getTrip`. UI lives under the existing `(shell)` route group. No new package, worker, or permission key.

## Complexity Tracking

> No Constitution Check violations. No new package, service, broker, table, enum, abstraction below the ≥3 threshold, or permission key (reuse `view_all_trips`, first-enforced here — mirrors 004's `import_trips`). Server-side pagination keeps a virtualization library unnecessary; CSV is built in-handler with no new dependency. This section is intentionally empty.
