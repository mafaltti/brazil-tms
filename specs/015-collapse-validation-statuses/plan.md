# Implementation Plan: Collapse Validation Statuses into "Recebida"

**Branch**: `015-collapse-validation-statuses` | **Date**: 2026-06-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/015-collapse-validation-statuses/spec.md`

## Summary

The trip lifecycle has three early states — `received` ("Recebida"), `validation_error` ("Erro de
validação") and `validated` ("Validada") — but import already validates every row (only valid/warning
rows are applied), so the separate trip-level validate hop is redundant. Slice 014 worked around the
"`received` is a dead end" trap by making imports **born `validated`**; this slice removes the hop
outright. **Collapse the three validation states into a single `received`**, making `received` itself the
first dispatchable status. `validation_error` and `validated` leave the **active** status machine
(18 → 16 values); the carrier-confirmation step (`confirmed`) and everything from `confirmed` onward are
**untouched**.

Technical approach (non-destructive, type-safe):

1. **Shared machine (source of truth)** — drop `validation_error`/`validated` from `TRIP_STATUSES`,
   `TRANSITIONS` (rewrite the `received` and `assigned` rows; delete the two dead rows) and
   `ACTIVE_TRIP_STATUSES`. `NON_EDITABLE_TRIP_STATUSES`, billing projections, and all `confirmed`-onward
   logic are unchanged.
2. **DB enum stays at 18 (2 dormant)** — Postgres cannot `DROP VALUE`. Leave `validation_error`/
   `validated` physically in the `trip_status` pgEnum (frozen by migration 0002 + the immutable
   `trip_events` history), mark them **dormant** in a comment, and **pin the Drizzle column type** to the
   16-value `TripStatus` via `.$type<TripStatus>()` on `trips.current_status` and `trips.disputed_from_status`
   (type-only, no SQL diff). This avoids a destructive enum-recreation migration and keeps typecheck aligned.
3. **Backfill migration 0008 (data-only)** — resolve any existing rows: `current_status` and
   `disputed_from_status` in `{validated, validation_error}` → `received`. `trip_events` history is left
   immutable. Scaffolded with `drizzle-kit generate --custom` (no schema diff).
4. **Born-received** — revert slice 014: drop `createTrip`'s `initialStatus` param; the two `confirm-import`
   call sites create trips at the default `received`. Manual create already `received`.
5. **Dispatch + assignment** — `DISPATCH_QUERY` `status=validated` → `status=received`; `assignTrip` source
   guard `validated` → `received`; `unassignTrip` target `validated` → `received` (the `assigned → received`
   unassign edge); the BFF assign/reassign branch key `validated` → `received`. Confirm route/service/hook
   untouched.
6. **UI** — assignment panel `ASSIGNABLE_STATUSES` and control-tower quick-assign gate on `received`;
   status-badge map and pt-BR labels drop the two removed keys; the unassign dialog copy reads "Recebida".
   The "Confirmar" button and its keys stay.
7. **Tests/e2e** — retarget `validated`→`received`; **invert** the slice-014 assertions that encode the old
   design ("received excluded from queue", "born Validada"); delete the born-validated unit test.

**Adds one durable artifact**: the data-only backfill migration (0008), required by FR-006. No new table,
column, enum value, index, permission, package, worker job, endpoint, or runtime dependency.

## Technical Context

**Language/Version**: TypeScript (strict), Node.js 22 · Next.js App Router (BFF) · single Node worker (pg-boss).

**Primary Dependencies**: existing only — Drizzle ORM + drizzle-kit, Zod, TanStack Query/Table, Luxon, shadcn/ui, Vitest/Playwright. **No new dependency.**

**Storage**: Postgres (self-hosted Supabase). One **data-only** migration (0008): backfill two columns; **no schema change** (the `trip_status` pgEnum keeps all 18 members; 2 become dormant). Drizzle column types pinned to `TripStatus` via `.$type<>()`.

**Testing**: Vitest (shared domain `trip-status.test.ts`; db/web integration for assign/unassign/transitions/create; worker `confirm.test.ts`/`duplicates.test.ts`), Playwright (dispatch/import/lifecycle/control-tower/inspector e2e).

**Target Platform**: Linux server (Docker Compose: app + worker), pt-BR UI, `America/Sao_Paulo`.

**Project Type**: Web (Next.js BFF + worker) in a monorepo (`apps/web`, `packages/{shared,db}`, `workers/`).

**Performance Goals**: unchanged — the machine is one hop shorter (no `received → validated`); no new query patterns. `trips_status_idx` already backs the `status=received` queue filter.

**Constraints**: polling-only (no Realtime); BFF-only authz; service-role key server-only; **explicit enumerated status machine (Constitution III)** — the machine stays explicit (16 active values) with declared legal transitions; removing two values does not weaken legality (transitions still route through guarded services). `import_batch_status` is a **separate** enum (also has `validated`/`confirming`) and is **never** touched.

**Scale/Scope**: a bounded-but-broad corrective slice — ~6 shared/db/worker source edits + ~8 web source edits + 1 data migration, and ~30 test/e2e files retargeted (several **inverted**, not just re-seeded). No `NEEDS CLARIFICATION` remain (scope and decisions resolved with the user, 2026-06-07; see research.md).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] **Simplicity (I)**: a net **simplification** — removes two states and one operator hop. Each edit is the minimal diff; no new abstraction, package, service, layer, or runtime dependency. The dormant-enum + `.$type<>()` approach is strictly simpler and safer than a destructive enum-recreation migration. The only durable addition is a one-statement data backfill required by FR-006.
- [x] **Scope (II)**: within execution MVP scope; corrective fix to the import→dispatch lifecycle. Amends the PRD §12 status machine (product source of truth) via this slice — allowed. Not a §29-gated, customer-signed-off surface. The `confirmed` collapse and a manual "Validar" UI remain explicitly out of scope.
- [x] **System-of-record (III)**: Postgres owns state; status stays an explicit enumerated machine (16 active values) with declared legal transitions. **`trip_events` history is preserved immutable** (never rewritten); only the live `trips.current_status`/`disputed_from_status` are backfilled, as a one-time vocabulary resolution (not a runtime/business transition — `validated → received` is not a legal lifecycle transition, so a migration is the correct, only tool). Original-plan immutability and `audit_logs` are untouched. Transitions out of `received`/`assigned` still route through guarded services.
- [x] **Authz & secrets (IV)**: no new endpoint, role, or exposure; nothing auth-related is deleted (the confirm route stays). The dispatch queue change hits the already-authorized `GET /api/trips`. The `trip.create` audit is unchanged in shape.
- [x] **Config over code (V)**: the one shared import engine and per-customer templates/status-mappings are untouched; no per-customer branch. Removing a system-wide status is a machine change, not customer variation.
- [x] **Tech constraints**: no Realtime/Edge/Redis/microservices/route-optimizer; polling unchanged; Postgres-backed queue + single worker unchanged; `import_batch_status` enum untouched.
- [x] **Workflow**: feature branch `015-…` off `dev`; PR targets `dev`; CI gates (lint/typecheck/build/tests) apply; AI does not merge to `main`.

**Result: PASS** (two design choices logged in Complexity Tracking for transparency — neither is a violation).

## Project Structure

### Documentation (this feature)

```text
specs/015-collapse-validation-statuses/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions (dormant enum, .$type, backfill, born-received, inversions)
├── data-model.md        # Phase 1 — the 16-value machine, transition rewrite, dormant enum, migration 0008
├── quickstart.md        # Phase 1 — how to verify (import→Recebida→assign; unassign→Recebida; backfill; no-regress confirm)
├── contracts/
│   └── collapse-validation-statuses.md   # status machine delta + createTrip/assign/unassign + dispatch query contracts
├── checklists/
│   └── requirements.md  # spec quality checklist (from /speckit-specify)
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
packages/shared/src/domain/
├── trip-status.ts                 # EDIT (source of truth) — TRIP_STATUSES drop "validation_error","validated" (→16);
│                                  #   TRANSITIONS: received→[assigned,cancelled]; assigned→[confirmed,received,cancelled]
│                                  #   (// received = unassign); DELETE validation_error & validated rows; confirmed-onward
│                                  #   UNCHANGED. ACTIVE_TRIP_STATUSES drop the 2 (→10). NON_EDITABLE unchanged (6). Fix
│                                  #   "18 values"/"12 active" header comments → 16/10.
└── trip-status.test.ts            # EDIT — length 18→16; ACTIVE 12→10; delete "validated→confirmed illegal"; rewrite the
                                   #   006-transitions block (received→assigned legal; assigned→received legal; keep
                                   #   assigned→confirmed); fix partition counts; fix "validation" comment.

packages/shared/src/schemas/
├── trip-assignment.ts             # EDIT (comments only) — assign-from is now "received" not "validated"; enum auto-shrinks.
├── trip-assignment.test.ts        # EDIT — expectedFromStatus "validated"→"received"; keep confirmAssignmentSchema block.
└── trip.ts                        # EDIT (comment only) — born-status note: imports born "received" (supersedes 014).

packages/db/schema/
├── enums.ts                       # EDIT (comment only) — mark trip_status "validation_error","validated" DORMANT
│                                  #   (slice 015): still members for history; removed from the active TS machine. KEEP all
│                                  #   18 enum values (no DROP). import_batch_status UNTOUCHED.
└── trips.ts                       # EDIT — current_status + disputed_from_status: add `.$type<TripStatus>()` to pin the
                                   #   Drizzle column type to the 16-value machine (type-only; no SQL diff). import TripStatus.

packages/db/src/trips/
├── trips-service.ts               # EDIT — REVERT slice 014: drop the `initialStatus` param + guard; createTrip inserts
│                                  #   current_status="received" and trip.create audit newValue="received" (hardcoded again).
├── trip-assignments.ts            # EDIT — assignTrip: source guard WHERE current_status="received" (was "validated"),
│                                  #   statusBefore/audit "received". unassignTrip: canTransition("assigned","received"),
│                                  #   set/event/audit "received". reassignTrip + confirmTripAssignment UNCHANGED.
└── (trip-plan.ts, trip-transitions.ts, completion.ts, trip-cancellation.ts, trip-events.ts, trips-read.ts, sla.ts)
                                   # UNCHANGED — trip-plan.ts indexOf("confirmed") stays valid (confirmed retained);
                                   #   trips-read buildWhere already composes status=received; the rest are generic.

packages/db/migrations/
└── 0008_<name>.sql                # NEW (data-only, --custom) — UPDATE trips SET current_status='received'
                                   #   WHERE current_status IN ('validated','validation_error');
                                   #   UPDATE trips SET disputed_from_status='received' WHERE disputed_from_status IN (…);
                                   #   trip_events history left intact. (+ journal/snapshot via drizzle-kit --custom)

workers/jobs/confirm-import/
├── index.ts                       # EDIT — the TWO createTrip sites drop the "validated" arg (born received);
│                                  #   header/inline comments: "born received"; updateTripPlan paths UNCHANGED;
│                                  #   setBatchStatus("validated") at the batch level is import_batch_status — DO NOT TOUCH.
└── confirm.test.ts                # EDIT — trip currentStatus "validated"→"received"; "validated→assigned" → "received→assigned"
                                   #   (expectedFromStatus); "never reverted" comment → received; KEEP all batch.status="validated".

workers/jobs/validate/index.ts     # EDIT (comment only) — stale "born validated (slice 014)" note → born received. No logic.
workers/jobs/detect-duplicates/duplicates.test.ts  # EDIT — walk received→assigned→…→at_origin (drop the validated leg;
                                   #   KEEP confirmed leg). "PAST confirmed" gate wording unchanged (confirmed retained).

apps/web/components/trips/
├── dispatch/dispatch-board.tsx    # EDIT — DISPATCH_QUERY "…status=validated…" → "…status=received…"; JSDoc.
├── dispatch/assignment-form.tsx   # EDIT (comments only) — assign-from "received"; isReassign/showConfirm/showUnassign UNCHANGED
│                                  #   (confirm retained). A `received` trip → assign; `assigned`/`confirmed` → reassign.
├── trip-detail/assignment-panel.tsx  # EDIT — ASSIGNABLE_STATUSES {"validated","assigned","confirmed"} → {"received","assigned","confirmed"}; JSDoc.
├── control-tower-table.tsx        # EDIT — quick-assign gate currentStatus==="validated" → "received"; comments.
└── trip-status-badge.tsx          # EDIT — STATUS_CLASS: remove "validation_error" + "validated" entries (Record<TripStatus> typechecks); KEEP "confirmed".

apps/web/app/api/trips/[id]/
├── assignment/route.ts            # EDIT — POST branch expectedFromStatus==="validated" → "received"; DELETE doc
│                                  #   "assigned→validated" → "assigned→received"; POST JSDoc. assignment/confirm/route.ts UNCHANGED.
└── status/route.ts                # EDIT (comment only) if it names the validate hop; logic generic.

apps/web/lib/
├── trips/client.ts                # EDIT (JSDoc only) — useAssignTrip "received"; useUnassignTrip "reverts → received";
│                                  #   useConfirmAssignment UNCHANGED.
├── trips/trip-assignments.ts      # UNCHANGED — still re-exports confirmTripAssignment (confirm retained).
└── imports/manual-create.ts       # UNCHANGED — already born "received".

apps/web/messages/pt-BR.json       # EDIT — remove Trips.status."validation_error" + "validated"; KEEP "confirmed";
                                   #   Dispatch.unassignConfirmBody "voltará para Validada" → "Recebida". KEEP confirm.* keys.

# Tests / e2e (apps/web)
apps/web/lib/trips/*.test.ts       # EDIT — trip-transitions, trip-assignments (delete born-validated paths/retarget STALE),
                                   #   trip-unassign (→received), trip-reassign (seed received; KEEP confirmed test),
                                   #   trips-service.test.ts (DELETE born-validated test), trips-read (validatedId→received,
                                   #   status filter), sla/sla-rules (validated→received; confirmed seeds KEEP),
                                   #   trip-events/trip-audit/alerts/exceptions (confirmed seeds KEEP; validated→received).
apps/web/e2e/*.spec.ts             # EDIT — dispatch-board (INVERT: received now INCLUDED), dispatch-assignment/authz/override/
                                   #   warnings (seed received; KEEP confirm tests), dispatch-reassign (unassign→received; rename
                                   #   seedValidatedTrip), execution-timeline/execution-authz (received→assigned; KEEP confirm),
                                   #   trip-import (INVERT: "Recebida" not "Validada"; KEEP batch "Validado"), trip-lifecycle
                                   #   (born Recebida; KEEP confirm step), trip-detail/trips-control-tower/trips-inspector
                                   #   (validated→received). sla-risk/alerts confirmed seeds KEEP. permission-coverage confirm row KEEP.

# UNCHANGED machinery (verified) — confirm flow & SLA confirmation are OUT OF SCOPE, do NOT touch:
#   confirmed status; confirmTripAssignment + /assignment/confirm/route.ts + useConfirmAssignment + the "Confirmar" button;
#   confirmAssignmentSchema + trip.confirm audit; confirmed_by/confirmed_at columns; sla-risk.ts missed_confirmation /
#   confirmationCutoffMinutes / unconfirmed_within_window; sla-sweep REASON_TO_ALERT map; trip-plan.ts review gate;
#   import_batch_status enum + all importBatches.status="validated"/"confirming" references; import engine; audit semantics.

# Docs
docs/PRD.md                        # EDIT — §12 status table (16) + §12.1 transitions; §7/§11.2/11.3/11.4/§19.1 prose
                                   #   (no validate hop); §30 decision-log entry (supersedes 014 born-validated).
CLAUDE.md                          # EDIT — SPECKIT block → point at this plan.
```

**Structure Decision**: Web monorepo (existing). The change radiates from one source of truth
(`packages/shared/src/domain/trip-status.ts`) into the db/worker/web seams that hardcode the two removed
statuses, plus one data migration. No new directories, packages, layers, endpoints, or i18n keys.

## Complexity Tracking

| Design choice (logged for transparency) | Why acceptable | Simpler/other alternative rejected because |
|---|---|---|
| **Dormant enum values + `.$type<TripStatus>()`** (keep `trip_status` at 18 in Postgres; shrink only the TS machine) | Postgres cannot `DROP VALUE`; the only true-removal path is recreating the type across 4 columns **and rewriting `trip_events` history**, which violates Constitution III (immutable audit history). Dormant values follow the repo's established precedent (dormant `import_templates` table) and add **nothing** to the DB. `.$type<>()` keeps typecheck honest with zero SQL impact. After the backfill, no live row holds a dormant value, and all writers are TS-typed to the 16-value machine. | **Enum recreation (Option B)** is destructive, rewrites immutable history (or forces keeping the old enum for events anyway, defeating itself), and is higher migration-failure risk on a live DB. **A CHECK constraint** forbidding the 2 values was considered as belt-and-suspenders but rejected for now (KISS — the BFF/type-system already prevent writes; it adds durable surface for no in-scope need). |
| **Data-only backfill migration 0008** (the one durable addition) | FR-006 requires existing `validated`/`validation_error` trips to resolve to `received` so nothing is stranded/unrenderable. `validated → received` is **not** a legal lifecycle transition, so `transitionTripStatus` cannot express it — a one-time migration `UPDATE` is the correct tool. `trip_events` history is preserved (not rewritten). | **Auditing each migrated row** (synthetic `audit_logs`/`trip_events`) was rejected as over-engineering a one-time vocabulary resolution and would pollute the append-only event trail. **Skipping the backfill** was rejected: a leftover dormant value would render as a missing i18n key and can break the page (per project memory on next-intl). |

*The reverted `createTrip` signature (dropping slice 014's optional `initialStatus`) and the
`.$type<TripStatus>()` column annotations are type-level/minimal-diff changes that remove surface rather
than add it; they are within Principle I, not tracked violations.*
