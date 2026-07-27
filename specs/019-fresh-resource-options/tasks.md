---

description: "Task list for slice 019 — Fresh Resource Options (no-reload freshness)"
---

# Tasks: Fresh Resource Options

**Input**: Design documents from `specs/019-fresh-resource-options/`
**Prerequisites**: plan.md, spec.md

## ⚠️ Traps

1. **Keep the server seed** — pages continue loading options server-side and passing them down; the
   hook takes them as `initialData` (FR-003). Do NOT drop the server load (empty first paint) and do
   NOT double-fetch on mount (initialData prevents it).
2. **Swap at ONE spot per surface** — the top-level client component; every child keeps receiving
   the same prop shape. No prop-drilling rework.
3. **`view_all_trips` only** on the new route — it is the one key all 7 internal roles hold; the
   page-level guards stay authoritative for page access.

## Phase 1: Setup

- [X] T001 Branch `019-fresh-resource-options` off `dev`; baseline lint/typecheck green.

## Phase 2: Foundational

- [X] T002 Create `apps/web/app/api/trips/filter-options/route.ts` (GET per plan).
- [X] T003 Edit `apps/web/lib/trips/client.ts`: `FILTER_OPTIONS_POLL_MS` + `useFilterOptions(initial)`.

## Phase 3: Adoption (US1+US2 — all nine surfaces)

- [X] T004 Assignment surfaces: `control-tower-table.tsx`, `trip-detail-client.tsx`,
      `dispatch-board.tsx` — swap the static prop for the hook at the top.
- [X] T005 Remaining six: the exceptions, reports, sla-rules, billing, rates, and
      document-requirements client components (resolve exact files; one swap each).

## Phase 4: e2e

- [X] T006 Create `apps/web/e2e/fresh-options.spec.ts`: dispatch open → db-insert driver → focus/
      visibility-triggered refetch (fallback one interval) → picker offers the driver, no reload;
      first-paint regression (lists immediately present).

## Phase 5: Polish & gates

- [X] T007 `pnpm -w lint && pnpm -w typecheck && pnpm -w build`; Vitest workspace green.
- [X] T008 Playwright vs the local mock-GoTrue stack: `fresh-options.spec.ts` + regression
      (`dispatch-board`, `searchable-pickers` if present on this branch — it is NOT (018 unmerged);
      use `dispatch-assignment` + `trips-control-tower`).
- [X] T009 PR to `dev`; CLAUDE.md SPECKIT block → this plan.
