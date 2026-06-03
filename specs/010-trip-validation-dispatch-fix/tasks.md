---

description: "Task list for 010 — Trip Validation Action & Dispatch Queue Hardening"
---

# Tasks: Trip Validation Action & Dispatch Queue Hardening

**Input**: Design documents from `/specs/010-trip-validation-dispatch-fix/`

**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅

**Tests**: INCLUDED — the plan's Testing section calls for e2e coverage (validate flow, queue, assignment error) plus the `messages.test.ts` i18n guard. Write each test FIRST and confirm it FAILS before implementing.

**Organization**: Tasks are grouped by user story. This is a **corrective brownfield slice** over shipped slices 003/005/006 — it adds NOTHING durable (no table, enum, migration, permission key, package, worker, or runtime dep). Most "implementation" tasks are small edits to existing files.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 / US2 / US3 (maps to spec.md user stories); Setup/Foundational/Polish carry no story label
- Exact file paths are included in every task

## Path Conventions

Existing monorepo: `apps/web/` (Next.js App Router + BFF), `packages/{shared,db}/`, e2e in `apps/web/e2e/`. No new package.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm baseline before changes (brownfield — no project init).

- [X] T001 Confirm work is on branch `010-trip-validation-dispatch-fix` (off `dev`) and capture a green baseline: `pnpm lint`, `pnpm -r typecheck`, `pnpm -r build` all pass before any edit.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Demo/e2e data so the hardened queue and validate→assign flow are exercisable. **⚠️ CRITICAL**: the dispatch/validate e2e specs depend on this — complete before the user-story phases.

- [X] T002 Refresh the dev seed in `packages/db/seed/trip-domain-sample.ts`: advance one demo trip `received → validated` via `transitionTripStatus` and one `validated → assigned` via `assignTrip` (a seed/admin actor), keeping at least one trip in `received`. MUST route through the services — **never** a raw `UPDATE current_status` (INV-1, Constitution III).
- [X] T003 e2e fixtures (corrects analyze finding **M1**): `db:seed:e2e` seeds **accounts only** (`e2e-accounts.ts`), so the Playwright specs **self-seed** their own trip rows via `@brazil-tms/db` (matching `dispatch-board.spec.ts`/`dispatch-assignment.spec.ts`). `trip-validate.spec.ts` self-seeds `received`/`validation_error`/`validated` trips; `dispatch-board.spec.ts` self-seeds `received`+`in_transit` (to assert exclusion) alongside its `validated` row; `dispatch-assignment.spec.ts` self-seeds `received`+`in_transit` for the `NOT_ASSIGNABLE` cases. The T002 `trip-domain-sample.ts` refresh serves the **demo** `db:seed:trip-domain` path only — NOT the e2e.

**Checkpoint**: Seeds produce `received` + `validated` + `assigned` trips through the status machine — user-story work can begin.

---

## Phase 3: User Story 1 — Validate a received trip (Priority: P1) 🎯 MVP

**Goal**: An operator can move a `received` trip to `validated` (and correct `validation_error → received`) from Trip Detail, via the existing `/status` endpoint, gated by `update_trip_status`.

**Independent Test**: As an `update_trip_status` holder, open a `received` trip's Trip Detail, activate Validate → trip becomes `validated` with one `status_change` event + one audit record; a non-holder cannot see/use it; the action is not offered for trips past `received`/`validation_error`.

### Tests for User Story 1 ⚠️ (write first, expect fail)

- [X] T004 [P] [US1] New e2e `apps/web/e2e/trip-validate.spec.ts`: (1) `received → validate` via Trip Detail → `validated`, asserting exactly one `trip_events` `status_change` row and one `audit_logs` `trip.status_change` row attributable to the actor; (2) `update_trip_status` holder gets `2xx`, a non-holder (e.g. Finance) gets `403` and the action is not rendered; (3) the Validate action is absent for a trip not in `received`/`validation_error`. (Uses `apiLogin` per repo e2e convention.)

### Implementation for User Story 1

- [X] T005 [US1] Create `apps/web/components/trips/trip-detail/validate-action.tsx` — a small client component shown only for `received`/`validation_error`; **reuses** `useRecordMilestone(trip.id)` (the generic `POST /status` mutation) with `{ expectedFromStatus: trip.currentStatus, toStatus: "validated" | "received", source: "operator_manual" }`; reuses the `Trips.detail` `error${code}` mapping pattern (see `timeline.tsx:72-79`) for `ILLEGAL_TRANSITION`/`STALE_TRANSITION`/`NOT_FOUND`. No new hook/endpoint/permission.
- [X] T006 [US1] Extend `apps/web/components/trips/trip-detail/trip-detail-client.tsx` to render `<ValidateAction trip={trip} />` when `trip.currentStatus ∈ {received, validation_error}` (place it near the status/summary, above the assignment panel). (Depends on T005.)
- [X] T007 [US1] Add `Trips.detail` validate labels to `apps/web/messages/pt-BR.json` (`validateAction` = "Validar", `validateHint`, `revertToReceived`, `validating`, plus any success text). Flat keys (no dots). ⚠️ Shares `pt-BR.json` with T013 — do not run these two in parallel.

**Checkpoint**: A `received` trip can be validated through the UI; US1 is independently demonstrable.

---

## Phase 4: User Story 2 — Dispatch queue lists only assignable trips (Priority: P1)

**Goal**: The Dispatch Board queue shows only `validated`, unassigned trips. **Ships with US1** (alone it empties the queue at current data; US1 supplies validated trips).

**Independent Test**: Seed a mix (`received`, `validated`-unassigned, `in_transit`, `assigned`); the queue lists only the `validated`-unassigned trip(s); clicking Assign on one succeeds.

### Tests for User Story 2 ⚠️ (write first, expect fail)

- [X] T008 [P] [US2] Extend `apps/web/e2e/dispatch-board.spec.ts`: assert the queue contains only `validated`, unassigned trips (no `received`/`in_transit`/already-assigned rows) and that a queued trip assigns successfully; assert the empty-state renders when no trip is `validated`.

### Implementation for User Story 2

- [X] T009 [US2] In `apps/web/components/trips/dispatch/dispatch-board.tsx`, change `DISPATCH_QUERY` (line 30) from `"assigned=false&scope=active&sort=pickupStart"` to `"status=validated&assigned=false&sort=pickupStart"`, and update the doc comment (lines ~22-27) to describe the `validated`-unassigned queue. No read-model change (the `status` filter is already supported — see `trips-read.ts:341-343`).

**Checkpoint**: The queue is truthful — every row is assignable. US1 + US2 together = the coherent MVP.

---

## Phase 5: User Story 3 — Clear message when a trip cannot be assigned (Priority: P2)

**Goal**: Assigning a non-assignable trip returns a distinct, accurate `NOT_ASSIGNABLE` (409) with a clear pt-BR message — for ALL non-assignable statuses — instead of the misleading reassignment-only `ILLEGAL_TRANSITION`. Defense-in-depth after US2.

**Independent Test**: Assigning a `received` (and an `in_transit`) trip → `409 NOT_ASSIGNABLE` + "A viagem precisa ser validada…"; `validated` still assigns; reassign from `assigned`/`confirmed` still works.

### Tests for User Story 3 ⚠️ (write first, expect fail)

- [X] T010 [P] [US3] Extend `apps/web/e2e/dispatch-assignment.spec.ts`: assigning a `received` trip and an `in_transit` trip each return `409` with code `NOT_ASSIGNABLE` and the pt-BR message; a `validated` trip still assigns (`2xx`); reassigning an `assigned`/`confirmed` trip still succeeds (regression guard).

### Implementation for User Story 3

- [X] T011 [US3] In `apps/web/app/api/trips/[id]/assignment/route.ts` (lines 32-35), replace the `expectedFromStatus === "validated" ? assignTrip : reassignTrip` ternary with an explicit branch: `validated → assignTrip`; `assigned`/`confirmed → reassignTrip`; **else → `throw new Conflict("NOT_ASSIGNABLE", "A viagem precisa ser validada antes da atribuição.")`**. Keep `reassignTrip`'s internal guard. Update the route docstring's Conflict-code list to include `NOT_ASSIGNABLE`.
- [X] T012 [P] [US3] In `apps/web/components/trips/dispatch/assignment-form.tsx` (lines 51-59), add `"NOT_ASSIGNABLE"` to the `ERROR_CODES` allowlist so `mapError` maps it to `Dispatch.errors.NOT_ASSIGNABLE` (else it degrades to `REQUEST_FAILED`).
- [X] T013 [US3] Add `Dispatch.errors.NOT_ASSIGNABLE` = "A viagem precisa ser validada antes de ser atribuída." to `apps/web/messages/pt-BR.json` (flat key under the existing `Dispatch.errors` object; no dotted key). ⚠️ Shares `pt-BR.json` with T007 — do not run these two in parallel.

**Checkpoint**: All three stories functional; the misleading message is unreachable for a `received`/in-flight trip.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T014 [P] Extend `apps/web/lib/messages.test.ts`: assert no dotted message keys; assert `Dispatch.errors.NOT_ASSIGNABLE` and the new `Trips.detail` validate keys (T007) exist (guards next-intl `INVALID_KEY` — only caught by render/this test).
- [X] T015 Verify the schema diff shows **ZERO** durable additions — no new migration, table, enum, or permission key (SC-007 / INV-5): `git diff --stat dev -- packages/db/migrations packages/db/schema packages/shared/src/auth/permissions.ts` is empty.
- [X] T016 Run the `quickstart.md` verification (US1/US2/US3 manual flow) + full `pnpm lint` / `pnpm -r typecheck` / `pnpm -r build`, then the targeted e2e against a **prod build** with `--workers=1` after `db:seed:e2e` (per repo e2e gotchas): `trip-validate.spec.ts`, `dispatch-board.spec.ts`, `dispatch-assignment.spec.ts`.
- [X] T017 [P] Write `specs/010-trip-validation-dispatch-fix/PR-NOTES.md`: state the principles applied (KISS/DRY/III/IV — reuse not new machinery), that it **closes #11**, the "adds nothing durable" guarantee, and the test evidence; open the PR with `gh pr create --base dev` (AI must NOT merge to `main`).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none — start immediately.
- **Foundational (Phase 2)**: depends on Setup; **blocks the e2e** in all user-story phases (T002 → T003).
- **User Stories (Phase 3–5)**: depend on Foundational. US1, US2, US3 are otherwise **independent** (different files), except the shared `pt-BR.json` (T007 vs T013) which must be serialized.
- **Polish (Phase 6)**: depends on all desired user stories; T014 depends on T007 + T013; T016 depends on all implementation + test tasks.

### User Story Dependencies

- **US1 (P1)** — independent. Files: `validate-action.tsx` (new), `trip-detail-client.tsx`, `pt-BR.json` (Trips.detail keys), `trip-validate.spec.ts`.
- **US2 (P1)** — independent. File: `dispatch-board.tsx` (+ its e2e). Pairs with US1 for a coherent MVP (ship together).
- **US3 (P2)** — independent. Files: `assignment/route.ts`, `assignment-form.tsx`, `pt-BR.json` (Dispatch.errors key), `dispatch-assignment.spec.ts`. Defense-in-depth; does not block US1/US2.

### Within Each User Story

- Test task (write first, FAIL) → implementation → re-run test (PASS).
- US1: `validate-action.tsx` (T005) before wiring it into `trip-detail-client.tsx` (T006).

### Parallel Opportunities

- After Foundational, US1 / US2 / US3 can proceed in parallel by different developers (mind the `pt-BR.json` serialization between T007 and T013).
- `[P]` test tasks (T004, T008, T010) are different files → parallel.
- `[P]` implementation tasks across stories (T009, T011/T012) are different files → parallel.

---

## Parallel Example: kicking off all three stories after Foundational

```bash
# Tests first (different files — parallel):
Task: "T004 e2e trip-validate.spec.ts (US1)"
Task: "T008 extend dispatch-board.spec.ts (US2)"
Task: "T010 extend dispatch-assignment.spec.ts (US3)"

# Then implementation (different files — parallel; serialize the two pt-BR.json edits):
Task: "T005 validate-action.tsx (US1)"
Task: "T009 DISPATCH_QUERY in dispatch-board.tsx (US2)"
Task: "T011 assignment/route.ts branch + NOT_ASSIGNABLE (US3)"
Task: "T012 ERROR_CODES in assignment-form.tsx (US3)"
```

---

## Implementation Strategy

### MVP = User Story 1 + User Story 2 (ship together)

1. Phase 1 Setup → Phase 2 Foundational (seed).
2. US1 (Validate action) **and** US2 (queue narrowing) — these are co-dependent: US2 alone empties the queue (no `validated` trips exist), US1 alone leaves the queue cluttered. Together they restore a working validate→assign flow.
3. **STOP and VALIDATE**: a `received` trip can be validated and then assigned entirely through the UI; the queue shows only assignable trips (SC-001, SC-002).
4. Demo / open PR to `dev`.

### Incremental

5. Add US3 (clear `NOT_ASSIGNABLE` message) — defense-in-depth; the misleading error becomes unreachable (SC-005).
6. Polish (i18n guard, schema-diff check, quickstart + e2e, PR notes).

---

## Notes

- `[P]` = different files, no incomplete-task dependency. The two `pt-BR.json` edits (T007, T013) are the only same-file collision — serialize them.
- This slice **reuses** the status endpoint/service/permission and the status machine; it creates **no** new write path, permission key, table, enum, migration, package, worker, or dependency (verify with T015).
- Route HTTP-status assertions live in **e2e** (repo convention — no `route.test.ts`); the only Vitest task here is the `messages.test.ts` i18n guard.
- e2e gotchas: run vs a **prod build**, `--workers=1`, reset data with `db:seed:e2e`; a stale `next dev` can hold broken HMR state for edited cross-package routes.
- Commit after each task or logical group; PR `--base dev`; **AI must not merge to `main`**.
