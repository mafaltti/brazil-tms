# Phase 0 — Research & Design Decisions: Dispatch Assignment and Conflict Warnings

**Feature**: 006-dispatch-assignment · **Date**: 2026-05-31 · **Spec**: [spec.md](./spec.md)

This slice has **no open NEEDS CLARIFICATION** — the spec's `/speckit-clarify` session resolved every decision that changes data model, scope, or tests (carrier-approval storage, block/warn defaults, minimum-required set, confirm gate, override authority). The remaining open items are low-risk configuration defaults (vehicle-type substitution, turnaround buffer) and deferred business policy (per-customer severity overrides, broader ownership policy) — all scaffolded as documented config, never invented (Constitution II). The decisions below pin the technical approach against the **existing** codebase patterns (002 fleet, 003 trip domain/service/audit, 005 read models + UI shell).

---

## R0 — Reuse vs build: what 006 adds

**Decision**: 006 introduces **exactly one new table** (`trip_assignments`), **one new pure domain module** (assignment-eligibility evaluator) + **one new Zod schema file** in `@brazil-tms/shared`, **assignment service functions** + **read-model extensions** in `@brazil-tms/db`, **~5 BFF endpoints** (3 new assignment routes + 2 extended), and the **Dispatch Board** screen + the **assignment panel / filters / view / row-indicator** that fill slice 005's shell. It adds **no new enum, no new permission key, no new package, no new worker**.

**Rationale**: DISP-001..009 + the PRD §14.1 Trip Assignment entity are exactly slice 006's ownership (SPEC-SLICING). Everything else (resources, trip model, status machine, transition service, audit, board/detail/dashboard read models, polling, i18n) already exists and is reused read-only or extended in place — Constitution I (DRY/YAGNI) and III (single source of record).

**Alternatives rejected**: a separate "conflict engine" package (violates the ≥3 rule and the 2-package constraint — the evaluator is one pure module in `shared`); a denormalized `trips.current_assignment_id` column (see R3 — a partial unique index is a single source without drift).

---

## R1 — `trip_assignments` table shape (PRD §14.1)

**Decision**: New table `trip_assignments` (snake_case, mirrors 002/003 conventions) with: `id` (uuid PK), `trip_id` (FK→trips, not null), `driver_id`/`vehicle_id`/`trailer_id`/`carrier_id` (FK→ respective, nullable), `assigned_by_user_id` (FK→users, not null) + `assigned_at` (timestamptz default now), `confirmed_by_user_id` (FK→users, nullable) + `confirmed_at` (timestamptz, nullable), `notes` (text, nullable), `override_reason` (text, nullable), `is_current` (boolean not null default true), `superseded_by_assignment_id` (self-FK, nullable) + `superseded_at` (timestamptz, nullable), `created_at`/`updated_at`. Full DDL in [data-model.md](./data-model.md).

**Rationale**: 1:1 with PRD §14.1's enumerated Trip Assignment fields; FKs use inline `.references(() => x.id)` with default `ON DELETE no action` (never cascade on domain tables — matches `trips`/`drivers`). The `is_current` boolean + `superseded_*` chain implements "at most one current assignment; reassignment supersedes and retains history" (Decision §30) **without** an assignment-status enum — so **no new enum** (Constitution I).

**Alternatives rejected**: a new `assignment_status` enum (unnecessary — `is_current` + supersession covers it); storing each assignment immutably and append-only (PRD models `confirmed_by/at` and `is_current` **on the same row**, i.e. the current row is updated — see R4).

## R2 — Single-current-assignment guarantee

**Decision**: Enforced by a **partial unique index** `trip_assignments_trip_active_uq ON (trip_id) WHERE is_current` — the exact pattern `trips_customer_external_id_uq` uses (`packages/db/schema/trips.ts`). A second concurrent assign on the same trip fails at the DB constraint, surfaced as `409`.

**Rationale**: DB-enforced invariant beats app-only checks (Constitution III); the partial unique index doubles as the fast "current assignment for trip" lookup for the board/detail joins.

## R3 — No denormalized FK on `trips`

**Decision**: Do **not** add a `current_assignment_id` column to `trips`. The current assignment is found via `trip_assignments WHERE trip_id = ? AND is_current` (single index hit on the partial unique index). `trips.ts` stays unchanged by 006.

**Rationale**: a back-reference column is a second source of truth that can drift from `is_current` (Constitution III — single source). The partial unique index makes the lookup O(1)-ish; no measurable benefit to denormalizing at the medium design scale.

## R4 — Assignment rows are mutable, history retained (not append-only)

**Decision**: `trip_assignments` is **not** REVOKE-hardened append-only. Confirmation **updates** the current row (`confirmed_by/at`); reassignment **updates** the prior row (`is_current=false`, `superseded_by`, `superseded_at`) and inserts a new current row — in one transaction. Rows are **never hard-deleted**; superseded rows are retained as immutable history (no UPDATE flips them back).

**Rationale**: PRD §14.1 places `confirmed_by/at` and `is_current`/`superseded_*` **on the assignment row**, implying in-place updates. Constitution III forbids hard delete of auditable history, not row updates; the audit trail (R8) + retained superseded rows preserve full reconstructability. `trip_events`/`audit_logs` remain the append-only record (they keep their REVOKE).

**Alternatives rejected**: append-only event-sourced assignments (over-engineered vs PRD's row model; YAGNI).

## R5 — Transitions reuse the status machine; assignment services mirror `transitionTripStatus`

**Decision**: Assignment **drives** the existing machine, never redefines it. `canTransition` (`@brazil-tms/shared`) already declares `validated→assigned`, `assigned→confirmed`, `assigned→validated` (unassign). New service functions in `packages/db/src/trips/trip-assignments.ts` — `assignTrip`, `reassignTrip`, `unassignTrip`, `confirmTripAssignment` — follow the **exact transaction pattern** of `transitionTripStatus`/`cancelTrip`: validate legality with `canTransition` **before** the tx; inside one `db.transaction`, do the guarded conditional update (`WHERE current_status = expectedFromStatus` → 0 rows ⇒ `Conflict("STALE_TRANSITION")`), insert the assignment/supersession row(s), insert a `trip_events` `status_change` row (for the status-changing operations), `writeAudit(...)`, then return `loadTripDetail(tx, tripId)`.

**Rationale**: `cancelTrip` is already a sibling of `transitionTripStatus` (not a caller of it) — assignment follows the same established sibling pattern, giving a single resource-rich audit row per action (R8) rather than a generic `trip.status_change` plus a second audit. `canTransition`/the guarded-update/`writeAudit`/`loadTripDetail` building blocks are reused (DRY).

**Note**: **reassignment does not change status** (the trip stays `assigned`/`confirmed`), so it writes **no** `trip_events` row — only the supersession row update + new row + a `trip.reassign` audit. This matches "reassignment supersedes; status unchanged" (spec FR-008).

## R6 — Eligibility/conflict evaluator is a pure function in `shared`

**Decision**: A pure, DB-free evaluator `evaluateAssignmentEligibility(ctx, policy)` in `packages/shared/src/domain/assignment-eligibility.ts` returns `Finding[]` (`{ check, resourceKind, resourceId, severity: "block" | "warn", code }`). The DB layer gathers the `ctx` (candidate resources with status/type/expiry/ownership, the trip's `planned_vehicle_type`/window, and the resource's **overlapping current assignments**) and calls the evaluator; the BFF orchestrates and enforces the outcome. Checks implement the §19.2 set: schedule overlap, resource status, vehicle-type match, carrier eligibility, documentation expired/missing.

**Rationale**: Constitution quality-gate (STACK §3.13) names **assignment-conflict checks** as a required Vitest focus — a pure evaluator is unit-testable without a DB. Authority lives server-side (Constitution III / STACK §6.1); the UI calls the dry-run check endpoint (R10) to *display* findings but never decides.

## R7 — Block/warn severity is config with the confirmed company default

**Decision**: A typed config object `DEFAULT_ASSIGNMENT_POLICY` in `shared` maps each check to `block`/`warn`, seeded with the **clarified company default**: **BLOCK** = resource `inactive`/`blocked`, vehicle/trailer `maintenance`, expired documentation, carrier not-active/contract-or-doc-expired; **WARN** = schedule overlap, vehicle-type mismatch, missing documentation, expiring-soon (≤30 days), resource `unavailable`. A `resolveSeverity(check, customerPolicy?)` seam accepts per-customer overrides, but **no per-customer override storage is built** (none provided — config data, YAGNI).

**Rationale**: spec clarification confirmed this table as the build/test target; Constitution V (config over code — never per-customer branches). The per-customer seam exists so adding overrides later is configuration, not rework.

## R8 — Audit & timeline for assignment changes

**Decision**: Add four `AuditAction` strings to `packages/shared/src/audit/actions.ts` (and `ALL_AUDIT_ACTIONS`): `trip.assign`, `trip.reassign`, `trip.unassign`, `trip.confirm`. Each assignment mutation writes one `audit_logs` row via the existing `writeAudit(tx, …)` with `entityType:"trip"`, `entityId:tripId`, resource-rich `previousValue`/`newValue` (e.g. `{ currentStatus, driverId, vehicleId, trailerId, carrierId }`), `actorUserId`, and `reason` = the override reason when present. Status-changing operations (assign/unassign/confirm) additionally insert a `status_change` `trip_events` row (reusing the existing `trip_event_type` value — **no new enum value**). `TRIP_CRITICAL_FIELDS` (`shared/domain/trip-status.ts`) is extended with the assignment reference fields (the file's comment already reserves this for 006).

**Rationale**: Constitution IV / STACK §5.4 require assignment changes to be audited; reusing `writeAudit` + the `status_change` event keeps the append-only record intact with no new mechanism. i18n: the four actions need **nested** keys under `Trips.auditActions.trip` **and** flat `_`-separated keys under `AuditActions` (the `messages.test.ts` guard enforces both, and next-intl forbids dotted message keys — see R12).

## R9 — Minimum-required set & confirm gate (clarified rules)

**Decision**: `requiredResourcesFor(ownership)` in `shared`: every assign requires **driver + vehicle**; **subcontracted** trips additionally require a **carrier**; trailer always optional. Enforced in `assignTrip` before the `validated→assigned` transition (else `Conflict("INCOMPLETE_ASSIGNMENT")`). `confirmTripAssignment` **re-runs the evaluator** and refuses (`Conflict("ASSIGNMENT_BLOCKED")`) if any **unresolved BLOCK** is present; WARNs already overridden at assignment do not block confirm.

**Rationale**: directly encodes the two clarifications (min-required set; confirm re-validates, refuses on BLOCK) so resource drift between assign and confirm is caught. Configurable (the required-set and severity are config), broader ownership policy deferred to §29 Input #6.

## R10 — BFF endpoints (assign / reassign / unassign / confirm / check)

**Decision**: 3 new route files under `apps/web/app/api/trips/[id]/assignment/`:
- `route.ts` → **POST** (assign when `validated`; reassign/supersede when `assigned`/`confirmed`) and **DELETE** (unassign → `validated`).
- `confirm/route.ts` → **POST** (confirm → `confirmed`).
- `check/route.ts` → **POST** dry-run: returns `{ findings }` (blocks + warnings) **without writing** — the server-authoritative source for the panel's inline warnings.

All gated `assign_resources` via `requirePermission(ctx, "assign_resources")`. Bodies validated by the new Zod schemas (R11). Outcomes: `200` with `{ item, findings }`; `409 OVERRIDE_REQUIRED` (WARNs present, no `overrideReason`) returning the warnings; `409 ASSIGNMENT_BLOCKED` (any BLOCK) returning the blocks; `409 STALE_TRANSITION`/`409 INCOMPLETE_ASSIGNMENT`; `404 NOT_FOUND`; `400 VALIDATION`. The board/detail reads (`GET /api/trips`, `GET /api/trips/:id`) are **extended** (assignment columns + filters; current assignment + history). `GET /api/dashboard/summary` is **extended** to fill `unassignedTrips`.

**Rationale**: mirrors the 003/005 handler contract exactly (`requireAuth`→`requirePermission`→Zod `parse`→service→`handleRouteError`). The check endpoint satisfies US2/§16 "inline warnings" while keeping conflict authority on the server (Constitution III). The Dispatch Board (§15.6) reuses the **extended trip board** (`assigned=false` + pickup sort) — no separate board endpoint (DRY).

**Alternatives rejected**: a single mega-endpoint with an `action` discriminator (less testable); a dedicated `/api/dispatch/board` read model (the existing board read model + an `assigned` filter covers it).

## R11 — Zod input schemas

**Decision**: New `packages/shared/src/schemas/trip-assignment.ts` exporting `assignTripSchema` (`driverId`/`vehicleId` uuid, `trailerId`/`carrierId` uuid nullable-optional, `expectedFromStatus` enum(TRIP_STATUSES), `notes` ≤2000, `overrideReason` ≤2000 optional), `confirmAssignmentSchema`, and `checkAssignmentSchema` (candidate resources only). Naming/shape mirror `transitionTripSchema` (`packages/shared/src/schemas/trip.ts`). Extend `trip-board.ts` with `assigned` (`"true"|"false"`), `driverId`, `vehicleId`, `carrierId` filter params. Add `export *` lines to `shared/src/index.ts`.

**Rationale**: matches the established schema convention exactly; `expectedFromStatus` carries the optimistic-concurrency expectation like `transitionTripSchema`.

## R12 — i18n (pt-BR), no dotted keys

**Decision**: Extend `apps/web/messages/pt-BR.json`: a new `Dispatch` namespace (board + panel + warning labels), assignment filter/view labels under `Trips.board`, and the four audit actions under **both** `Trips.auditActions.trip` (nested: `assign`/`reassign`/`unassign`/`confirm`) **and** `AuditActions` (flat: `trip_assign`/`trip_reassign`/`trip_unassign`/`trip_confirm`). The `assigned` trip status label already exists (`Trips.status.assigned = "Atribuída"`).

**Rationale**: `apps/web/lib/messages.test.ts` enforces (a) **no key contains "."** — next-intl's nesting separator throws `INVALID_KEY` at `getMessages()` and breaks every render (matches the known pitfall), and (b) every `ALL_AUDIT_ACTIONS` entry has a flat `AuditActions` key. Both must pass.

## R13 — UI: fill 005's shell + the Dispatch Board

**Decision**: (a) Replace `AssignmentPlaceholder` (`apps/web/components/trips/trip-detail/placeholders.tsx`, rendered at `trip-detail-client.tsx:70`) with a new `AssignmentPanel` (current assignment + resource pickers + live findings from the check endpoint + assign/reassign/unassign/confirm actions). (b) Append an `"unassigned"` preset to `DEFAULT_TRIP_VIEWS` (`apps/web/lib/trips/views.ts` — its comment already reserves the slot) and add assigned/driver/vehicle/carrier filters to `trip-filters.tsx` + an assignment column/row-indicator to `control-tower-table.tsx`. (c) New **Dispatch Board** screen at `apps/web/app/(shell)/dispatch/page.tsx` reusing the extended board (unassigned-by-pickup) + the assignment panel/quick-assign. (d) The dashboard `unassignedTrips` widget needs **no UI change** — it auto-renders the count once the read model returns a number (`widgets.tsx` `metric()` placeholder logic). New client hooks in `lib/trips/client.ts` (`useAssignTrip`/`useReassignTrip`/`useUnassignTrip`/`useConfirmAssignment`/`useAssignmentCheck`) follow the `useUpdateTripPlan` mutation pattern and invalidate the `["trips"]` root.

**Rationale**: 005 built the framework precisely so 006 extends arrays/registries rather than reworking (FR-023/024). Resource selection (pickers + driver/vehicle/carrier filters) does **not** call 002's `/api/master-data/*` fleet endpoints (those are gated `manage_fleet_data`, which the `assign_resources` Dispatcher role does **not** hold → `403`); instead the active fleet lists (id + label) are produced by **extending `getTripFilterOptions`**, loaded **server-side** by the page loaders and surfaced to the client — no new resource endpoints.

## R14 — Migration

**Decision**: One drizzle migration `packages/db/migrations/0005_*.sql` (next sequential prefix after `0004_flat_northstar.sql`): `CREATE TABLE trip_assignments` + FK constraints + the partial unique index + conflict-lookup indexes. **No** `CREATE TYPE` (no new enum), **no** REVOKE (assignments are mutable — R4), **no** `ALTER TABLE trips`. Generated by `drizzle-kit generate`; verified by hand (no hand-edits expected since there is no REVOKE/cross-feature FK activation this time).

**Rationale**: matches the established migration flow; the schema-file edit (`trip-assignments.ts` + barrel export) drives generation.

## R15 — Performance & freshness

**Decision**: Conflict lookups backed by partial indexes on `trip_assignments` current-resource columns (R2/data-model). Assignment + full check completes within **2 s** (SC-003); Dispatch Board loads within **3 s** at medium scale (SC-006). Freshness = **polling** reusing 005's cadence (`CONTROL_TOWER_POLL_MS = 30s`), no Realtime/Edge Functions.

**Rationale**: medium scale (≤~10k active trips) inherited from 005; indexed current-assignment lookups keep both the board and the conflict check well within targets.

---

### Resolved unknowns summary

| Topic | Resolution |
|-------|-----------|
| New schema | one table `trip_assignments`; no new enum/key/package/worker (R0, R1, R14) |
| One-current-assignment | partial unique index `(trip_id) WHERE is_current` (R2) |
| Status transitions | reuse `canTransition` + sibling services mirroring `transitionTripStatus` (R5) |
| Conflict authority | pure evaluator in `shared`, gathered+enforced server-side (R6) |
| Block/warn | confirmed company default config; per-customer seam, no storage (R7) |
| Audit/timeline | 4 new `trip.*` actions via `writeAudit`; `status_change` event reused (R8) |
| Min-required / confirm gate | driver+vehicle (+carrier if subcontracted); confirm re-checks, refuses on BLOCK (R9) |
| Endpoints | 3 new assignment routes + 2 extended reads + dashboard fill (R10) |
| i18n | nested + flat audit keys; no dotted keys (R12) |
| UI | fill 005 placeholders/registries + new Dispatch Board (R13) |

**No NEEDS CLARIFICATION remain.** Low-risk open defaults (vehicle-type substitution = exact match; turnaround buffer = 0 min) and deferred business policy (per-customer severity, broader ownership) are documented config, not built (Constitution II).
