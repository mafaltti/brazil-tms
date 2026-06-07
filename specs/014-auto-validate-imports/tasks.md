# Tasks: Auto-Validate Imported Trips

**Input**: Design documents from `specs/014-auto-validate-imports/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/auto-validate-imports.md, quickstart.md

**Tests**: INCLUDED — the constitution's test focus (status transitions, import validation, assignment-conflict checks via Vitest; critical flows via Playwright) covers exactly this slice. Test tasks are written with/before the code they cover.

**Organization**: Tasks are grouped by user story (US1–US3 from spec.md). This is a corrective slice that **adds nothing durable**; the `createTrip` signature change is a shared prerequisite (Foundational). Same-file tasks are sequenced (noted inline) rather than marked `[P]`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1 / US2 / US3 (setup, foundational, polish have no story label)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Make the import→dispatch flow exercisable end-to-end.

- [X] T001 Verify the dev environment per `quickstart.md`: app (`pnpm --filter @brazil-tms/web dev`) + worker (`pnpm --filter @brazil-tms/workers dev`) running against the app DB (port 5433); seed `db:seed:master-data` + `db:seed:locations` (so import `origem`/`destino` codes resolve) + `db:seed:resources` (demo drivers/vehicles/trailers, needed to actually assign). Note: the single Node worker **must be restarted** after the `confirm-import` edit (T005) or a stale process keeps the old `received` behavior.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared `createTrip` capability that the born-validated import path (US1) and the no-downgrade invariant (US2) both depend on. **US3 (dispatch queue) is independent of this phase** and may proceed in parallel.

**⚠️ CRITICAL**: US1 and US2 cannot begin until T002 is complete.

- [X] T002 Edit `packages/db/src/trips/trips-service.ts`: extend `createTrip` with an **optional 3rd parameter** `initialStatus: TripStatus = "received"` (after `actorUserId`); replace the hardcoded `currentStatus: "received"` at the insert (~L63) **and** in the `trip.create` audit `newValue` (~L85) with `initialStatus`. Import `TripStatus` from `@brazil-tms/shared` if not already. The default preserves all 11 existing callers; `CreateTripInput`/`createTripSchema` stay unchanged (status is a fn param, not parsed input). Per `contracts/auto-validate-imports.md` §1.
- [X] T003 [P] Extend `apps/web/lib/trips/trips-service.test.ts` (the `createTrip` test lives in the **web** project — there are no `.test.ts` files in `packages/db`): keep the existing default assertion (`createTrip(input, actor)` → `currentStatus === "received"`); **add** a case `createTrip(input, actor, "validated")` → `currentStatus === "validated"` AND the `trip.create` audit row's `newValue.currentStatus === "validated"`. Depends on T002.

**Checkpoint**: `createTrip` can be born at any initial status, fully audited; every existing caller is unchanged. `transitionTripStatus`, `updateTripPlan`, and `manual-create.ts` are intentionally **untouched**.

---

## Phase 3: User Story 1 - Imported trips are immediately dispatch-ready (Priority: P1) 🎯 MVP

**Goal**: After confirming an import, newly created trips are born `validated` and can be assigned right away — no manual validation step.

**Independent Test**: Import + confirm a correct file → the created trips show "Validada" on the Control Tower and assign successfully from Expedição (`validated → assigned`), with no `ILLEGAL_TRANSITION`.

- [X] T004 [P] [US1] Edit `workers/jobs/confirm-import/confirm.test.ts`: change the created-trip assertion (`expect(t.currentStatus).toBe("received")`, ~L167) to `"validated"` and rename the test accordingly (e.g. "creates trips **born validated** linked to the batch; re-running confirm is idempotent"); **add** a test that a confirm-created trip assigns immediately — call `assignTrip(tripId, {…, expectedFromStatus: "validated"}, actor)` and assert `currentStatus === "assigned"`. (Write with T005; fails until it lands.) Depends on T002.
- [X] T005 [US1] Edit `workers/jobs/confirm-import/index.ts`: pass `"validated"` as the `initialStatus` arg at the **two** `createTrip` call sites — the `new`/`potential_duplicate` branch (~L149) and the `update`-vanished→create branch (~L171). **Leave the `updateTripPlan` paths unchanged** (the `update` branch ~L167 and the unique-race fallback ~L156). Update the header comment to record the **labeled decision (FR-009)**: replace "Imported trips land in `received` … import never transitions status" with a note that newly created trips are **born `validated`** — because the trip-level validation gate (PRD §11) is satisfied by import-time per-row validation — and that import never changes an **existing** trip's status. Restart the worker after this edit. Per `contracts/auto-validate-imports.md` §2 (invariants I1–I3). Depends on T002.
- [X] T006 [US1] Edit e2e `apps/web/e2e/trip-import.spec.ts`: after the confirm step, assert the created trips' status is **"Validada"** (not "Recebida") on the post-import surface the spec already checks (Control Tower / preview). Depends on T005.

**Checkpoint**: US1 fully functional — imported trips are born validated and assignable (the MVP). Deployable on its own.

---

## Phase 4: User Story 2 - Updates to in-flight trips never lose their status (Priority: P2)

**Goal**: An import `update` to a trip that has progressed (e.g. already `assigned`) updates its plan but does **not** revert its status. **No source change** beyond US1 — the `updateTripPlan` paths are already status-neutral (T005 leaves them untouched); this story guards the invariant with a test.

**Independent Test**: Create + assign a trip, then confirm an import `update` row matching it with changed plan fields → the trip's plan changes but its status stays `assigned`.

- [X] T007 [US2] Add to `workers/jobs/confirm-import/confirm.test.ts`: seed/confirm a trip (born `validated`), assign it (`assignTrip` → `assigned`), then process an import `update` row matching the same `(customerId, externalTripId)` with a changed plan field → assert the existing trip's `currentStatus` stays `"assigned"` (NOT reverted to `validated`) and its plan field updated. Also cover the unique-race fallback: a `new` row that re-resolves to `updateTripPlan` on an existing non-`validated` trip leaves that trip's status unchanged (FR-002, invariant I2). Same file as T004 → **after T004**. Depends on T005.

**Checkpoint**: US1 + US2 verified — born-validated for new trips, status-preserving for updates.

---

## Phase 5: User Story 3 - The dispatch queue only offers assignable trips (Priority: P3)

**Goal**: The Expedição assignment queue lists only unassigned `validated` trips, so every "Atribuir" it offers can succeed. Independent of US1/US2 (only the dispatch query).

**Independent Test**: With a `received` trip and a `validated` trip both unassigned, the Expedição queue shows only the `validated` one; clicking "Atribuir" on it succeeds.

- [X] T008 [US3] Edit `apps/web/components/trips/dispatch/dispatch-board.tsx`: change `DISPATCH_QUERY` (~L30) from `"assigned=false&scope=active&sort=pickupStart"` to **`"assigned=false&status=validated&sort=pickupStart"`**. (A non-empty `status` suppresses the `scope=active` default in `buildWhere` and composes with `assigned=false` → only unassigned validated trips; `status` is read via `params.getAll`.) Per `contracts/auto-validate-imports.md` §3.
- [X] T009 [US3] Edit e2e `apps/web/e2e/dispatch-board.spec.ts`: alongside the existing seeded `validated` trip, **seed an unassigned `received` trip**; assert the Expedição queue lists **only** the `validated` trip (the `received` one is **absent**), and that "Atribuir" on the validated trip opens the dialog and a complete assignment succeeds. Depends on T008.

**Checkpoint**: All three stories independently verifiable.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T010 [P] Confirm no unintended change: `apps/web/lib/imports/manual-create.ts` still creates `received` (default param); the `updateTripPlan`/`no_op`/race paths in `confirm-import` are untouched; no new i18n key, migration, enum value, endpoint, or permission was introduced.
- [X] T011 [P] Run typecheck + lint + **`next build`** for `apps/web` (the build — not just `tsc` — catches `route.ts` export rules + next-intl issues), plus `tsc` for `packages/db`, `packages/shared`, and `workers`.
- [X] T012 Run the test suites green — including the **full untouched-path suites** to back **SC-006 (no regression)**, not just the changed ones: the **entire** `pnpm --filter @brazil-tms/workers test` (confirm-import / validate / detect-duplicates / parse / generate-error-report); `pnpm exec vitest run --project web apps/web/lib/trips/trips-service.test.ts` (with `DATABASE_URL` set; this file is part of the web suite below); the web integration suite `pnpm exec vitest run --project web`; and the e2e `pnpm --filter @brazil-tms/web test:e2e -- trip-import` and `-- dispatch-board` (prod build, `--workers=1`).
  - **RESULT (2026-06-07)**: full **workers** project green (39/39 — confirm-import, validate, detect-duplicates, parse, generate-error-report, sla-sweep, billing-export) and full **web** project green (41 files / 229 tests). The full-suite run surfaced one **SC-006 regression the R7 census missed**: `workers/jobs/detect-duplicates/duplicates.test.ts` case (e) walked a *confirm-created* trip `received → validated`, but those trips are now born `validated` — fixed by starting the legal-path walk at `validated` (the test's REVIEW_REQUIRED purpose is unchanged). The **two browser e2e specs (T006/T009) were NOT executed here**: the Playwright `webServer` reuses the existing `:3000` dev server (`reuseExistingServer`), which was already occupied by a running session — running them would be unreliable (stale-HMR hazard) and could disrupt that session. Run them in a clean e2e env (free `:3000`, fresh prod build, `--workers=1`); their behaviors are already covered by the green worker + web integration suites.
- [ ] T013 Run the `quickstart.md` manual walk (import→Validada→assign; an `update` keeps an assigned trip's status; the queue excludes a `received` trip). **Requires restarting the dev worker first** so it loads the new `confirm-import` code. (PENDING human walk; the automated equivalents — `confirm.test.ts`, `trips-service.test.ts`, the full workers suite, and the trip-import + dispatch-board e2e — cover the same behavior.)

---

## Dependencies & Execution Order

### Phase order
- **Setup (P1)** → **Foundational (P2)** → **US1 (P3)** → **US2 (P4)** → **Polish (P6)**.
- **US3 (P5)** is **independent of Foundational/US1/US2** (only the dispatch query) and may run in parallel with them.

### Key task dependencies
- T003 depends on T002; **T004, T005 depend on T002**; T006 depends on T005; **T007 depends on T005**.
- T009 depends on T008. (T008/T009 depend on nothing in P2–P4.)

### Same-file sequencing (NOT parallel)
- `workers/jobs/confirm-import/confirm.test.ts`: **T004 → T007**.
- `apps/web/e2e/trip-import.spec.ts`: single task **T006**.
- `apps/web/e2e/dispatch-board.spec.ts`: single task **T009**.
- `workers/jobs/confirm-import/index.ts`: single task **T005**.

### Parallel opportunities
- **T003 [P]** (db unit test) alongside **T004 [P]** (worker test) — different files.
- **US3 (T008 → T009)** in parallel with the entire US1/US2 track (different files, no shared dependency).
- Polish: **T010 [P]** + **T011 [P]**.

---

## Implementation Strategy

### MVP first (US1 only)
1. Phase 1 Setup → Phase 2 Foundational (the `createTrip` param + its unit test).
2. Phase 3 US1 (confirm-import passes `"validated"` + tests) → **STOP and validate**: import → Validada → assign succeeds. This alone unblocks the import→dispatch flow — shippable.

### Incremental delivery
3. US2 → guard the no-downgrade invariant (test only).
4. US3 → narrow the dispatch queue (one query string + e2e).
5. Polish → build/lint/full-suite/quickstart.

---

## Notes

- **No durable additions**: no table, column, enum value, migration, permission, package, worker job, or dependency — only a backward-compatible optional `createTrip` param + one client query string.
- **Intentionally untouched** (do not edit): `packages/db/src/trips/trip-transitions.ts` (`transitionTripStatus`), the `updateTripPlan`/`no_op`/unique-race paths in `confirm-import`, `apps/web/lib/imports/manual-create.ts` (manual create stays `received`), and the legal-transition table. All dispatch e2e already seed `currentStatus:"validated"`, and `import-batches-service.test.ts` asserts **batch** status — leave them as-is.
- **Worker restart** is required after T005 before any manual verification (stale worker keeps `received`).
- `[P]` = different files, no incomplete dependency. Commit after each task or logical group. PR targets `dev` (never `main`); AI does not merge to `main`.
