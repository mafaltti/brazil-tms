# Implementation Plan: Master Data and Operational Configuration

**Branch**: `002-master-data-config` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-master-data-config/spec.md`

## Summary

Authorized users maintain the master data required to execute trips — **customers, locations, lanes, drivers,
vehicles, trailers, carriers** — through Administration (commercial) and Resource Management (fleet) screens.
Technical approach: **extend the running feature-001 stack** (no new infra, no worker). Add seven `public`
tables + four enums in `packages/db` (Drizzle), shared Zod schemas in `packages/shared`, BFF Route Handlers
under `apps/web/app/api/master-data/*`, thin service modules, and `(shell)` screens. Authorization, audit
(`writeAudit`), i18n (pt-BR), formatting, and the BFF/route-error patterns are **reused unchanged** from 001.
Removal is non-destructive **archive** (`archived_at`); resources carry an explicit operational `status` and an
owned/subcontracted classification; every critical change is audited in the same transaction. All four
`/speckit-clarify` decisions and both `/speckit-specify` gating inputs are resolved (see research.md), so there
are no open clarifications.

## Technical Context

**Language/Version**: TypeScript 5.6 (strict); Node.js 20 LTS; pnpm 10 monorepo.

**Primary Dependencies** (already in the repo from 001): Next.js 15 (App Router) + React 19; Drizzle ORM
(`drizzle-orm ≥0.36`, `drizzle-kit ≥0.28`) over `postgres` (3.4) — direct server-only connection;
`@supabase/ssr` + `@supabase/supabase-js` (auth/session only); Zod 3.23; `next-intl` 4 (pt-BR);
TanStack Query 5 + TanStack Table 8; react-hook-form 7 + `@hookform/resolvers`; Tailwind 3 + shadcn/ui (Radix)
+ lucide-react; Luxon 3.

**Storage**: self-hosted Supabase Postgres. **New** app-schema tables (`public`): `customers`, `locations`,
`lanes`, `drivers`, `vehicles`, `trailers`, `carriers`; **new** enums: `resource_status`, `ownership_type`,
`vehicle_type`, `trailer_type`. Writes to the existing `public.audit_logs` (reused). Access via Drizzle
(server-only); PostgREST/gateway never exposed.

**Testing**: Vitest (Zod schemas, permission-catalog invariants, `documentExpiryState`, service-layer lane
integrity + ownership invariant + audit writes); Playwright (CRUD + archive, status cycle, expiry flag,
owned/subcontracted, permission denial UI+API, audit presence).

**Target Platform**: Linux server via Docker Compose (Supabase, app, Caddy); evergreen browsers. Worker unused.

**Project Type**: Web application — existing monorepo (`apps/web` + `packages/{shared,db}`); no new package.

**Performance Goals**: no hard latency target (interactive admin CRUD). Lists return flat arrays filtered by
query params with TanStack Query polling (`staleTime ≈ 30s`); master-data volumes are modest for MVP.

**Constraints**: BFF-only data access; service-role key server-only; gateway/PostgREST never public; **NO**
Realtime / Edge Functions / external broker / microservices / route optimizer; freshness via polling; UI
pt-BR; timestamps UTC (displayed `America/Sao_Paulo`); money as integer centavos, BRL.

**Scale/Scope**: 7 entities; ~11 screens (7 list + detail/edit, grouped Administration + Resource Management) +
~35 BFF route methods (5-route shape × 7 entities); 4 new enums; 2 new permission keys; ~24 audit actions.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Confirm this plan complies with `.specify/memory/constitution.md`:

- [x] **Simplicity (I)**: Reuses 001's auth/audit/i18n/formatting/BFF primitives; **no new package or service**.
  New abstractions are deferred (no shared `contacts` table — jsonb per entity, R8; no generic `audit()`
  wrapper until ≥3 identical call sites, R10; no per-row currency, R7; no server pagination, R11). The two new
  permission keys are the minimum to express the clarified split (R2). Per-entity services repeat a small CRUD
  shape (<3 *identical* — they differ by validation/integrity), so they stay explicit, not abstracted yet.
- [x] **Scope (II)**: Within master-data MVP. Out-of-scope areas are deferred and labeled, not absorbed:
  SLA (007), document requirements (008), import templates (004), resource calendars (RES-008 Later),
  unknown-location mapping (LANE-005 → 004), assignment policy (006). §29 Input #6 is resolved at the
  master-data level (explicit ownership flag) with assignment policy left to 006; `vehicle_type`/`trailer_type`/
  carrier status value sets are **documented defaults** (labeled scaffolding per II), not marked final.
- [x] **System-of-record (III)**: Postgres owns all state. **Soft-delete only** (`archived_at`; no hard delete);
  `resource_status` is an explicit enum (no free-form strings); the owned/subcontracted invariant and lane
  same-customer rule are enforced at the DB (CHECK) / service layer; audit history is the immutable, append-only
  `public.audit_logs` reused from 001, written in the same transaction as each mutation.
- [x] **Authz & secrets (IV)**: All access via the BFF (`requireAuth()` + `requirePermission()`); service-role
  key stays server-only; gateway not exposed; create/edit/archive/status-change are all audited
  (FR-025/FR-028). Archive is Admin-only via `delete_archive` (FR-027).
- [x] **Config over code (V)**: Customer variation is data (customer rows), no per-customer code path.
  `vehicle_type`/`trailer_type` are a closed **product** enum (not customer-specific behavior), which V permits;
  customer-specific behavior (templates/SLA/docs) is explicitly NOT built here.
- [x] **Tech constraints**: self-hosted Supabase (Postgres/Auth/Storage); Drizzle migrations; polling-only.
  NO Realtime, NO Edge Functions, NO Redis/BullMQ, NO microservices, NO route optimizer. No worker needed.
- [x] **Workflow**: on `002-master-data-config` (off `dev`); PR will target **`dev`**; CI gates
  (lint/typecheck/build/tests) must pass; permission/archive/audit are explicit test targets; PR template used.

**Result: PASS** (both at Phase 0 and re-checked after Phase 1 design — the design introduced no new package,
service, broker, or constitution exception). Complexity Tracking is therefore empty.

One **noted, non-violating** decision: 002 edits the code-defined permission catalog to add two keys. This is
DRY-compliant (single source of truth stays in `packages/shared/src/auth/permissions.ts`; no DB permissions
table) and is the correct home for new keys; it does not breach Principle V.

## Project Structure

### Documentation (this feature)

```text
specs/002-master-data-config/
├── plan.md              # This file
├── research.md          # Phase 0 — design decisions (R0–R12)
├── data-model.md        # Phase 1 — 7 entities, 4 enums, integrity, audit actions
├── quickstart.md        # Phase 1 — setup, migration, test scenarios
├── contracts/
│   ├── bff-endpoints.md      # 7 entities × 5-route shape
│   └── permission-matrix.md  # 2 new keys + reuse delete_archive
├── checklists/
│   └── requirements.md  # spec quality checklist (from /specify, /clarify)
└── tasks.md             # Phase 2 — created by /speckit-tasks (NOT here)
```

### Source Code (repository root) — extends the existing monorepo

```text
packages/db/
├── schema/
│   ├── enums.ts                       # + resource_status, ownership_type, vehicle_type, trailer_type
│   ├── customers.ts  locations.ts  lanes.ts            # NEW (commercial)
│   ├── drivers.ts  vehicles.ts  trailers.ts  carriers.ts  # NEW (fleet)
│   └── index.ts                       # + re-export the new tables
├── migrations/                        # + generated SQL (drizzle-kit generate) for the 7 tables/enums
└── seed/master-data-sample.ts         # OPTIONAL demo seed

packages/shared/src/
├── auth/permissions.ts                # + manage_commercial_data, manage_fleet_data (ALL_PERMISSIONS, ROLE_PERMISSIONS)
├── audit/actions.ts                   # + ~24 master-data AuditAction literals
├── schemas/master-data.ts             # NEW — create/update Zod per entity (pt-BR), reused UI + BFF
└── formatting.ts                      # + documentExpiryState(expiry, now, windowDays=30) helper

apps/web/
├── app/
│   ├── (shell)/admin/
│   │   ├── customers/page.tsx  customers/[id]/page.tsx
│   │   ├── locations/page.tsx  locations/[id]/page.tsx
│   │   └── lanes/page.tsx      lanes/[id]/page.tsx
│   ├── (shell)/resources/
│   │   ├── drivers/page.tsx    drivers/[id]/page.tsx
│   │   ├── vehicles/page.tsx   vehicles/[id]/page.tsx
│   │   ├── trailers/page.tsx   trailers/[id]/page.tsx
│   │   └── carriers/page.tsx   carriers/[id]/page.tsx
│   └── api/master-data/
│       ├── customers/route.ts  customers/[id]/route.ts        # GET list/POST ; GET/PATCH/DELETE
│       ├── locations/…  lanes/…  drivers/…  vehicles/…  trailers/…  carriers/…
├── lib/master-data/
│   ├── customers-service.ts  locations-service.ts  lanes-service.ts
│   └── drivers-service.ts  vehicles-service.ts  trailers-service.ts  carriers-service.ts
├── components/master-data/            # list table + entity forms (shadcn/ui + react-hook-form)
├── lib/nav.ts                         # + master-data nav items (gated by the 2 new permissions)
├── messages/pt-BR.json                # + MasterData / Resources namespaces
└── e2e/master-data.spec.ts            # Playwright
```

**Structure Decision**: Extend the existing web-application monorepo (`apps/web` BFF+UI,
`packages/shared` schemas/permissions/audit-actions, `packages/db` schema/migrations) exactly as feature 001
established it. **No new package or service** (Constitution I / STACK §7); `workers/` stays unused (master-data
CRUD has no background work). New code follows 001's file conventions one-to-one: `pgTable`/`pgEnum` schema,
`requireAuth()` + `requirePermission()` guarded route handlers delegating to `lib/*-service.ts`, mutations
wrapped in a Drizzle transaction that calls `writeAudit(tx, …)`, Zod schemas shared from `packages/shared`, and
shadcn/ui + react-hook-form forms.

## Complexity Tracking

> No constitution violations — this section is intentionally empty. No new project, package, service, broker,
> ORM, or pattern beyond what feature 001 already established is introduced.
