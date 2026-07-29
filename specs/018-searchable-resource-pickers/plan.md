# Implementation Plan: Searchable Resource Pickers (Type/Paste to Select)

**Branch**: `018-searchable-resource-pickers` | **Date**: 2026-07-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/018-searchable-resource-pickers/spec.md`

## Summary

Issue #25 [0002]: the assignment form's four resource pickers (and the board's three resource
filters) are plain Radix `Select`s — no typing, no pasting; similar names/plates are error-prone to
pick. This slice replaces their INTERNALS with one shared, hand-rolled **searchable combobox**
(ARIA combobox pattern over the existing `Input` + a positioned listbox), keeping every external
behavior of the form (values stay resource IDs; eligibility checks, override, write path untouched):

1. **`SearchableSelect`** (NEW, `components/ui/searchable-select.tsx`) — text input filters the
   bounded, server-loaded option list client-side; case/accent-insensitive (plates also ignore
   `-`/space via a `mode`); exact-unique normalized match → **auto-select** (the paste flow, FR-003);
   "Nenhum resultado" empty state; ↑/↓/Enter/Esc + click; optional pinned clear item (reboque/
   transportadora "Sem …", filters "Todos"); Label/id wiring preserved per field.
2. **`normalizeForSearch(text, mode)`** (NEW, `lib/search-normalize.ts`) — NFD diacritic strip,
   lowercase, whitespace collapse (+ separator strip for `"plate"`), unit-tested.
3. **`assignment-form.tsx`** — `ResourceSelect` keeps its name/props and delegates to
   `SearchableSelect` (`mode="plate"` for veículo/reboque); all three entry points inherit (FR-008).
4. **`trip-filters.tsx`** — the assigned driver/vehicle/carrier filters adopt the same component
   (clarification 2026-07-27); customer/origin/destination/lane filters unchanged.

**No new dependency** (no cmdk/popover — Constitution I), no BFF/db/permission change, no i18n
namespace beyond a few `Dispatch`/`Trips.board` keys.

## Technical Context

**Language/Version**: TypeScript (strict), Next.js App Router — presentation layer only.

**Primary Dependencies**: existing only (React, Radix primitives already vendored via shadcn/ui, Tailwind). **No new dependency** — the combobox is ~150 lines over `Input` + a `role="listbox"` popover div (the shadcn cmdk combobox would add 2 packages for behavior this covers).

**Storage / API**: none touched. Option lists remain the server-loaded `resourceOptions` (bounded active fleet; client-side filtering per spec Assumptions).

**Testing**: Vitest — `search-normalize.test.ts` (pure); Playwright — new `searchable-pickers.spec.ts` (paste auto-select driver; plate normalization incl. hyphen/space; multi-match no auto-select; empty state; keyboard-only pick; clear options; board filter paste) + existing `dispatch-assignment`/`dispatch-board` suites as the FR-007/SC-003 regression net.

**Target Platform / Project Type**: unchanged (web monorepo, pt-BR).

**Performance Goals**: filtering ≤ a few hundred options in-memory per keystroke — no measurable cost; no new polling or queries.

**Constraints**: keyboard + screen-reader parity (ARIA combobox: `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`, options `role="option"`); form values remain IDs (FR-007).

**Scale/Scope**: 2 NEW files (component + normalize helper w/ test) · 2 EDITs (`assignment-form.tsx`, `trip-filters.tsx`) · i18n keys · 1 NEW e2e spec. No `NEEDS CLARIFICATION` (1 resolved 2026-07-27).

## Constitution Check

- [x] **Simplicity (I)**: one shared component replacing four+three identical dropdowns (the ≥3 rule is satisfied at birth); hand-rolled over existing primitives instead of two new packages; no new layer/abstraction beyond it.
- [x] **Scope (II)**: direct issue-#25 fix inside shipped screens; no §29-gated surface; master-data pages and other dropdowns explicitly out of scope.
- [x] **System-of-record (III)**: untouched — no state, status, or write-path change (FR-007 pins it).
- [x] **Authz & secrets (IV)**: untouched — same server-loaded options under the same page guards; no new endpoint.
- [x] **Config over code (V)**: n/a — no customer variation involved.
- [x] **Tech constraints**: no Realtime/Edge/Redis/etc.; polling untouched.
- [x] **Workflow**: branch `018-…` off `dev`; PR to `dev`; CI gates.

**Result: PASS** — no violations, no Complexity Tracking entries.

## Project Structure

### Documentation (this feature)

```text
specs/018-searchable-resource-pickers/
├── plan.md              # This file (research folded in — small presentation-only slice)
├── spec.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
apps/web/lib/
└── search-normalize.ts            # NEW — normalizeForSearch(text, mode: "text" | "plate"):
                                   #   NFD strip diacritics → lowercase → trim + collapse spaces;
                                   #   "plate" also strips /[-\s]/g. + search-normalize.test.ts (pure).

apps/web/components/ui/
└── searchable-select.tsx          # NEW — SearchableSelect({ id, value, options {id,label}, onChange,
                                   #   placeholder, mode, clearable?, clearLabel?, emptyText }):
                                   #   Input shows selected label (or search text while open); opens on
                                   #   focus/click; filters via normalizeForSearch CONTAINS; exact-unique
                                   #   full-label match → auto-select + close (FR-003); ARIA combobox +
                                   #   activedescendant; ↑/↓/Enter/Esc; mousedown-preventDefault list so
                                   #   blur doesn't eat clicks; pinned clear item when clearable.

apps/web/components/trips/dispatch/
└── assignment-form.tsx            # EDIT — ResourceSelect keeps name/API, delegates to SearchableSelect;
                                   #   mode="plate" for veículo/reboque; labels/ids/clearable unchanged;
                                   #   findings/override/write path UNTOUCHED.

apps/web/components/trips/
└── trip-filters.tsx               # EDIT — assigned driver/vehicle/carrier filters → SearchableSelect
                                   #   (clearable, clearLabel = "Todos" semantics mapping to __all__);
                                   #   customer/origin/destination/lane Selects UNCHANGED.

apps/web/messages/pt-BR.json       # EDIT — Dispatch.searchNoResults "Nenhum resultado" (+ reuse of
                                   #   existing placeholders); any picker-specific search placeholders.

apps/web/e2e/
└── searchable-pickers.spec.ts     # NEW — US1 paste full driver name → auto-selected + assign completes;
                                   #   US2 plate paste "abc-1234"→ABC1234 auto-select; multi-match shows
                                   #   both, no auto-select; empty state; keyboard-only pick; "Sem reboque"
                                   #   reachable while searching; US3 board filter paste narrows the board.
                                   #   (dispatch-assignment.spec.ts et al must keep passing — SC-003;
                                   #   their Select interactions may need the combobox interaction instead.)

# UNCHANGED: all BFF routes/services, resourceOptions loading, eligibility evaluator, i18n structure.
```

**Structure Decision**: one generic UI component + one pure helper; consumers keep their public
shape. The existing e2e that drive the pickers are part of the change surface (their `Select`
interactions become combobox interactions) — this is the SC-003 regression net, not new scope.

## Complexity Tracking

None.
