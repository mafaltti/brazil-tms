---

description: "Task list for slice 015 — Collapse Validation Statuses into Recebida"
---

# Tasks: Collapse Validation Statuses into "Recebida"

**Input**: Design documents from `specs/015-collapse-validation-statuses/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/collapse-validation-statuses.md, quickstart.md

**Tests**: This slice **edits existing tests** that hardcode the removed statuses (required for CI green —
the constitution mandates status-transition tests). These are not optional TDD; they are part of each
phase. Several test changes are **inversions** (the assertion encodes the old design), not re-seeds.

**Organization**: by user story (US1 dispatch-from-Recebida, US2 unassign→Recebida, US3 legacy backfill),
after a blocking Foundational phase that changes the source-of-truth machine.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: different file, no dependency on an incomplete task → parallelizable
- **[Story]**: US1 / US2 / US3 (Setup/Foundational/Polish carry no story label)

## ⚠️ Two traps that apply to EVERY task

1. **`import_batch_status` is a SEPARATE enum** that also contains `validated`/`confirming`. **Never blind
   find-replace `'validated'`.** Keep every `importBatches.status` / `setBatchStatus(…)` / batch-progress /
   import-UI reference. Change **trip** status only.
2. **`confirmed` and everything `confirmed`-onward are OUT OF SCOPE** — keep the confirm route/service/hook/
   button/schema/audit, `confirmed_*` columns, the SLA confirmation cutoff, `sla-sweep` maps, and the
   `trip-plan.ts` review gate. Keep all `confirmed` test seeds.

---

## Phase 1: Setup

- [X] T001 Confirm branch `015-collapse-validation-statuses` (off `dev`) is checked out and capture a baseline `pnpm -w typecheck` (expected green pre-change) from the repo root.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: change the source-of-truth machine + DB typing + the import born-status. The TS `TripStatus`
union shrinks here, which turns every stale `"validated"`/`"validation_error"` literal in the repo into a
typecheck error — so repo-wide `typecheck` only goes green after the US phases fix those literals.

**⚠️ CRITICAL**: No user-story work should land before this phase is complete.

- [X] T002 Edit `packages/shared/src/domain/trip-status.ts`: remove `"validation_error"` and `"validated"` from `TRIP_STATUSES` (→16) and `ACTIVE_TRIP_STATUSES` (→10); rewrite `TRANSITIONS` — `received: ["assigned","cancelled"]`, `assigned: ["confirmed","received","cancelled"]` (comment `// received = unassign`), delete the `validation_error` and `validated` rows, leave `confirmed`-onward unchanged; fix header comments ("18 values"→16, "12 active"→10). NON_EDITABLE/billing sets unchanged.
- [X] T003 [P] Edit `packages/db/schema/enums.ts`: keep all 18 `trip_status` members; add a comment marking `validation_error`/`validated` **dormant** (slice 015 — retained for `trip_events` history, removed from the active TS machine). Do NOT modify `import_batch_status`.
- [X] T004 [P] Edit `packages/db/schema/trips.ts`: `import type { TripStatus } from "@brazil-tms/shared"`; append `.$type<TripStatus>()` to the `current_status` and `disputed_from_status` column builders (type-only; no SQL diff).
- [X] T005 Edit `packages/db/src/trips/trips-service.ts`: revert slice 014 — drop the `initialStatus` parameter, the `InitialTripStatus` type, and the received/validated guard; `createTrip` inserts `current_status = "received"` and writes the `trip.create` audit `newValue.currentStatus = "received"` (hardcoded); update the header doc to "born received".
- [X] T006 [P] Edit `packages/shared/src/domain/trip-status.test.ts`: `TRIP_STATUSES` length 18→16; `ACTIVE_TRIP_STATUSES` 12→10; delete the `validated → confirmed is illegal` case; rewrite the 006-transitions block — `received → assigned` legal (assign), `assigned → received` legal (unassign), **keep** `assigned → confirmed`; fix the partition literals (10+6=16) and the "must pass through validation" comment.

**Checkpoint**: source-of-truth machine reduced to 16; DB columns typed to it; imports born `received`.

---

## Phase 3: User Story 1 - Dispatch a trip straight from "Recebida" (Priority: P1) 🎯 MVP

**Goal**: imported trips land as "Recebida", appear in the Expedição queue, and assign directly
("Recebida" → "Atribuída") with no validate hop and no `ILLEGAL_TRANSITION`.

**Independent Test**: import + confirm a batch → trips show "Recebida" in `/dispatch` → assign one → it
becomes "Atribuída"; the "Validar" step is gone.

### Implementation for User Story 1

- [X] T007 [US1] Edit `workers/jobs/confirm-import/index.ts`: drop the `"validated"` argument at the **two** `createTrip` sites (born `received`); update the header + inline comments to "born received"; leave the `updateTripPlan` paths and `setBatchStatus(…, "validated")` (import_batch_status) UNTOUCHED.
- [X] T008 [P] [US1] Edit `apps/web/components/trips/dispatch/dispatch-board.tsx`: `DISPATCH_QUERY` `"assigned=false&status=validated&sort=pickupStart"` → `"assigned=false&status=received&sort=pickupStart"`; rewrite the JSDoc (born-received, `received → assigned`).
- [X] T009 [US1] Edit `packages/db/src/trips/trip-assignments.ts` **`assignTrip`**: optimistic source guard `WHERE current_status = 'received'` (was `'validated'`); `status_change` event `statusBefore = 'received'`; audit `previousValue.currentStatus = 'received'`; update its doc-comments. (Same file as T028 — do T009 before T028.)
- [X] T010 [P] [US1] Edit `apps/web/app/api/trips/[id]/assignment/route.ts`: POST branch key `expectedFromStatus === 'received'` → `assignTrip` (else `reassignTrip`); update the POST JSDoc and the DELETE JSDoc (`assigned → received`). Leave `assignment/confirm/route.ts` untouched.
- [X] T011 [P] [US1] Edit `apps/web/components/trips/trip-detail/assignment-panel.tsx`: `ASSIGNABLE_STATUSES` → `new Set(["received","assigned","confirmed"])`; update the JSDoc.
- [X] T012 [P] [US1] Edit `apps/web/components/trips/control-tower-table.tsx`: quick-assign visibility gate `currentStatus === "received"` (was `"validated"`); update the comments.
- [X] T013 [P] [US1] Edit `apps/web/components/trips/trip-status-badge.tsx`: remove the `validation_error` and `validated` entries from `STATUS_CLASS` (the `Record<TripStatus,…>` now typechecks at 16); keep `confirmed`.
- [X] T014 [P] [US1] Edit `apps/web/messages/pt-BR.json`: remove `Trips.status.validation_error` and `Trips.status.validated`; keep `received`/`assigned`/`confirmed`/… and all `Dispatch.confirm*` keys. (Same file as T029 — coordinate.)
- [X] T015 [P] [US1] Edit `apps/web/components/trips/dispatch/assignment-form.tsx`: comments only (assign-from is now `received`); leave `isReassign`/`showConfirm`/`showUnassign` and the "Confirmar" button intact.
- [X] T016 [P] [US1] Edit `apps/web/lib/trips/client.ts`: JSDoc only — `useAssignTrip` "a `received` trip"; leave `useConfirmAssignment` unchanged. (Same file as T030 wording check — coordinate.)

### Tests for User Story 1

- [X] T017 [US1] Edit `workers/jobs/confirm-import/confirm.test.ts`: trip `currentStatus` assertions `validated`→`received`; the "assigns immediately" test → `received → assigned` (`expectedFromStatus: "received"`); the "never reverted" wording → `received`. **KEEP** every `importBatches.status === "validated"` (batch enum).
- [X] T018 [P] [US1] Edit `workers/jobs/detect-duplicates/duplicates.test.ts`: the "moved past confirmed" setup walk `received → assigned → at_origin` (drop the `validated` leg; keep the `confirmed` leg/wording).
- [X] T019 [P] [US1] Edit `apps/web/lib/trips/trip-assignments.test.ts`: seeds + `expectedFromStatus` `validated`→`received`; keep the confirm test; re-point the STALE-source test (was seeded `received` expecting STALE because the guard wanted `validated`) to a genuinely non-`received` status so it still fails legality.
- [X] T020 [P] [US1] Edit `apps/web/lib/trips/trip-transitions.test.ts`: the full-lifecycle path drops the `validated` leg (`received → assigned → confirmed → …`); the `received → validated` single-hop probe → `received → assigned`; re-point the stale-source test off `validated`.
- [X] T021 [P] [US1] Edit `apps/web/lib/trips/trips-service.test.ts`: **delete** the born-`validated` test (the `createTrip(input, actor, "validated")` case); keep the default-`received` create test.
- [X] T022 [P] [US1] Edit `packages/shared/src/schemas/trip-assignment.test.ts`: `expectedFromStatus: "validated"`→`"received"` in the `assignTripSchema` cases; keep the `confirmAssignmentSchema` describe block.
- [X] T023 [P] [US1] Edit `apps/web/e2e/dispatch-board.spec.ts`: **INVERT** — seed the queue trips as `received`; the previously-excluded `received` trip is now **included**; retitle "received → assigned". Mirror the new `DISPATCH_QUERY`.
- [X] T024 [P] [US1] Edit `apps/web/e2e/trip-import.spec.ts`: **INVERT** — post-confirm the trip badge reads **"Recebida"** (not "Validada"); the trip `currentStatus` is `received`. **KEEP** the import-batch `["received","parsing","validating","validated"]` polling line (batch enum).
- [X] T025 [P] [US1] Edit `apps/web/e2e/dispatch-assignment.spec.ts`: seed `received`; assign from `received`; **keep** the `/assignment/confirm → confirmed` test (confirm retained).
- [X] T026 [P] [US1] Edit `apps/web/e2e/dispatch-authz.spec.ts`, `dispatch-override.spec.ts`, `dispatch-warnings.spec.ts`: `validated`→`received` seeds + "still validated"→"still received" asserts; keep the confirm-route authz block.
- [X] T027 [P] [US1] Edit `apps/web/e2e/execution-timeline.spec.ts` and `execution-authz.spec.ts`: the setup chain `received → assigned` (drop the `validated` leg); **keep** the confirm step + any `seedTrip("confirmed")`; the illegal-jump probe `assigned → loaded` stays illegal.

**Checkpoint**: import → Recebida → assign works end-to-end; confirm step still present.

---

## Phase 4: User Story 2 - Unassigning returns a trip to "Recebida" (Priority: P2)

**Goal**: removing an assignment returns the trip to "Recebida" (was "Validada"), it reappears in the
queue, and the dialog says "Recebida".

**Independent Test**: assign a "Recebida" trip → unassign → status is "Recebida", back in the queue, dialog
copy reads "Recebida".

### Implementation for User Story 2

- [X] T028 [US2] Edit `packages/db/src/trips/trip-assignments.ts` **`unassignTrip`**: `canTransition("assigned","received")`; `set current_status = "received"`; `status_change` event `statusAfter = "received"`; audit `newValue.currentStatus = "received"`; update the header/doc-comments. (After T009 — same file.)
- [X] T029 [US2] Edit `apps/web/messages/pt-BR.json` `Dispatch.unassignConfirmBody`: "…a viagem voltará para **Recebida**…" (was "Validada"). (Same file as T014 — coordinate.)

### Tests for User Story 2

- [X] T030 [P] [US2] Edit `apps/web/lib/trips/trip-unassign.test.ts`: seed `received` + assign from `received`; assert unassign returns to **`received`** (`statusAfter === "received"`, `statusBefore === "assigned"`); update title/doc.
- [X] T031 [P] [US2] Edit `apps/web/lib/trips/trip-reassign.test.ts`: `seedAssignedTrip` inserts `received` + assigns from `received`; **keep** the "reassign legal from `confirmed`" test and the stale-`confirmed` test.
- [X] T032 [P] [US2] Edit `apps/web/e2e/dispatch-reassign.spec.ts`: unassign asserts `received`; rename the `seedValidatedTrip` helper; the reassign branch keeps `assigned`/`confirmed`.

**Checkpoint**: unassign → Recebida works and round-trips back into the queue.

---

## Phase 5: User Story 3 - Existing trips in the removed states are resolved (Priority: P3)

**Goal**: any pre-existing `validated`/`validation_error` trip resolves to `received` so nothing is
stranded or unrenderable; history is preserved.

**Independent Test**: seed a `validated` and a `validation_error` trip → apply the migration → both read
"Recebida", render with a badge, and are dispatchable; `trip_events` history rows are untouched.

### Implementation for User Story 3

- [X] T033 [US3] Scaffold the data migration: `pnpm --filter @brazil-tms/db exec drizzle-kit generate --custom --name=collapse_validation_statuses` (creates `packages/db/migrations/0008_collapse_validation_statuses.sql` + journal/snapshot entries; no schema diff expected).
- [X] T034 [US3] Fill `packages/db/migrations/0008_collapse_validation_statuses.sql` with the backfill: `UPDATE "trips" SET "current_status" = 'received' WHERE "current_status" IN ('validated','validation_error');` and `UPDATE "trips" SET "disputed_from_status" = 'received' WHERE "disputed_from_status" IN ('validated','validation_error');`. Do **not** modify `trip_events` (immutable history).
- [X] T035 [US3] Apply + verify: `pnpm --filter @brazil-tms/db db:migrate`; run the SQL checks in quickstart §1 (0 live trips and 0 `disputed_from_status` in the dormant statuses; `trip_events` history may remain > 0).

**Checkpoint**: legacy rows resolved to Recebida; no row holds a dormant status.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T036 [P] Retarget the remaining lib integration tests that seed/assert trip `validated` → `received` (keep all `confirmed` seeds): `apps/web/lib/trips/{trips-read,sla,sla-rules,trip-audit,trip-events,assignment-override,assignment-check}.test.ts`.
- [X] T037 [P] Retarget the remaining e2e that seed trip `validated` → `received`: `apps/web/e2e/{trip-detail,trips-control-tower,trips-inspector}.spec.ts` (rename `validatedId`; change `?status=validated` board filters to `received`); verify `alerts.spec.ts`/`sla-risk.spec.ts` keep their `confirmed` seeds; verify `permission-coverage.spec.ts` keeps the confirm row.
- [X] T038 [P] Comment-only updates: `packages/shared/src/schemas/trip.ts` (born-received note, drop the slice-014 "born validated" line), `packages/shared/src/schemas/trip-assignment.ts` (assign-from `received`), `workers/jobs/validate/index.ts` (stale "born validated" comment → received; no logic change).
- [X] T039 [P] Amend `docs/PRD.md`: §12 status table → 16 (remove the `Validation Error` and `Validated` rows); §12.1 transition table → `received → Assigned/Cancelled`, `assigned → Confirmed/Received(unassign)/Cancelled`, delete the two removed source rows; §7/§11.2/§11.3/§11.4/§19.1 prose drop the separate validate hop; add a §30 decision-log entry recording the collapse and that it **supersedes slice 014's born-validated** decision.
- [X] T040 Run static gates from repo root: `pnpm -w lint && pnpm -w typecheck && pnpm -w build`; fix any residual `validated`/`validation_error` trip-status literal surfaced (do NOT touch `import_batch_status`).
- [X] T041 Run Vitest per quickstart §3 (shared `trip-status.test.ts`; db/web `trip-assignments`/`trip-unassign`/`trip-transitions`/`trips-service`; worker `confirm.test.ts`/`duplicates.test.ts`); confirm the born-validated test is gone and the inverted assertions pass.
- [X] T042 Restart the pg-boss worker (prove the running one via a live enqueue; the `trip.create` audit born status must read `received`); then run Playwright per quickstart §4 (`db:seed:e2e`, prod build, `--workers=1`): `dispatch-board`, `dispatch-assignment`, `trip-import`, `trip-lifecycle`, `trips-control-tower`.
- [X] T043 Manual smoke per quickstart §5: import → Recebida → assign → **confirm still works** → execution; unassign → Recebida; no "Validada"/"Erro de validação" visible in any badge/filter/queue/dialog/inspector; a seeded legacy trip shows Recebida.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)** → **Foundational (P2)** blocks everything (it shrinks `TripStatus`).
- **US1 (P3)**, **US2 (P4)**, **US3 (P5)** all depend on Foundational; US3 is independent of US1/US2.
- **Polish (P6)** runs after the story phases; T040/T041/T042/T043 are the final gates and depend on **all** literal/test edits (incl. T036/T037) being done.

### Story dependencies & file conflicts

- **US1 ↔ US2** share `packages/db/src/trips/trip-assignments.ts` (T009 assign before T028 unassign) and `apps/web/messages/pt-BR.json` (T014 labels, T029 dialog copy — sequential, same file). Otherwise independent.
- **US3** (migration) touches only `packages/db/migrations/**` — fully parallel to US1/US2.

### Within a story

- Source edits before their test edits where they share a file; `[P]` test edits across different files run together.

## Parallel Opportunities

- Foundational: T003, T004, T006 in parallel (T002 first as the source-of-truth change; T005 independent).
- US1 implementation: T008, T010–T016 in parallel after T007/T009 land (distinct files).
- US1 tests: T017–T027 largely in parallel (distinct files; mind the pt-BR coordination).
- US2: T030–T032 in parallel after T028/T029.
- US3: T033→T034→T035 are sequential (same migration file/DB).
- Polish: T036, T037, T038, T039 in parallel; then T040→T041→T042→T043 sequential gates.

## Implementation Strategy

- **MVP = Foundational + US1**: delivers the user's headline outcome (import → Recebida → assign with no
  validate hop). Stop and validate here (quickstart §5.1–§5.2) before US2/US3.
- **Incremental**: add US2 (unassign→Recebida), then US3 (legacy backfill), each independently testable.
- **Single developer**: follow T001→T043 in order; the `[P]` markers show where edits are independent.

## Notes

- `[P]` = different file, no incomplete-task dependency.
- Every task is a concrete edit with a file path; several test tasks are **inversions** (T021 delete, T023/
  T024 invert) — re-seeding alone would pass for the wrong reason.
- Keep `import_batch_status` and the entire `confirmed`/confirm flow untouched (see the two traps up top).
- Restart the worker after T007 before trusting any import e2e (MEMORY `stale_duplicate_worker_masks_fix`).
- Commit after each task or logical group; PR targets `dev` (never `main`).
