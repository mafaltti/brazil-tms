---

description: "Task list for slice 018 — Searchable Resource Pickers (type/paste to select)"
---

# Tasks: Searchable Resource Pickers

**Input**: Design documents from `specs/018-searchable-resource-pickers/`
**Prerequisites**: plan.md, spec.md

## ⚠️ Traps

1. **The write path is untouchable** (FR-007/SC-003): values stay resource IDs; the debounced
   eligibility check, override reason, and assign/reassign/confirm/unassign flows must behave
   byte-identically. Only the picker interaction changes.
2. **Existing e2e drive the old Select** — `dispatch-assignment.spec.ts`, `dispatch-board.spec.ts`,
   `dispatch-override.spec.ts`, `dispatch-warnings.spec.ts`, `dispatch-reassign.spec.ts`,
   `trips-control-tower.spec.ts` (filters). Their picker interactions must be updated to the
   combobox pattern and MUST still pass (they are the regression net).
3. **`__all__` sentinel** in trip-filters maps to "no filter" — keep its semantics when converting
   the three resource filters (clear item = "Todos").

## Phase 1: Setup

- [X] T001 Branch `018-searchable-resource-pickers` off `dev`; baseline `pnpm -w lint && pnpm -w typecheck` green.

## Phase 2: Foundational

- [X] T002 Create `apps/web/lib/search-normalize.ts` — `normalizeForSearch(text, mode)` per plan + `search-normalize.test.ts` (accents, casing, whitespace collapse, plate separators).
- [X] T003 Create `apps/web/components/ui/searchable-select.tsx` — the ARIA combobox per plan (filter CONTAINS, exact-unique auto-select, empty state, keyboard, clear item, blur-safe clicks).
- [X] T004 [P] Add pt-BR keys (`Dispatch.searchNoResults` etc.).

## Phase 3: US1+US2 — assignment form

- [X] T005 Edit `apps/web/components/trips/dispatch/assignment-form.tsx`: `ResourceSelect` delegates to `SearchableSelect` (`mode="plate"` on veículo/reboque); props/labels unchanged.
- [X] T006 Create `apps/web/e2e/searchable-pickers.spec.ts` — driver paste auto-select + full assign; plate normalization; multi-match no auto-select; empty state; keyboard-only; clear options.
- [X] T007 Update existing dispatch e2e picker interactions to the combobox (trap 2) and keep them green.

## Phase 4: US3 — board resource filters

- [X] T008 Edit `apps/web/components/trips/trip-filters.tsx`: assigned driver/vehicle/carrier → `SearchableSelect` (clear = "Todos"/`__all__`); other filters untouched.
- [X] T009 Extend `searchable-pickers.spec.ts`: board filter paste narrows the board; update `trips-control-tower.spec.ts` filter interactions if needed.

## Phase 5: Polish & gates

- [X] T010 `pnpm -w lint && pnpm -w typecheck && pnpm -w build`.
- [X] T011 Vitest (workspace runner) — new normalize tests + full web suite green.
- [X] T012 Playwright vs the local mock-GoTrue stack (`C:\Users\brazil\.local\brazil-tms-dev\`): `searchable-pickers.spec.ts` + the trap-2 regression suites.
- [X] T013 PR to `dev` (never `main`); CLAUDE.md SPECKIT block → this plan.

## Dependencies

T002 → T003 → {T005, T008}; e2e after their surface lands; gates last. No file conflicts between
US phases except the shared new spec file (sequential T006 → T009).
