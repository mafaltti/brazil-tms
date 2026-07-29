# Implementation Plan: Fresh Resource Options (New Driver Appears Without Reload)

**Branch**: `019-fresh-resource-options` | **Date**: 2026-07-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/019-fresh-resource-options/spec.md`

## Summary

Issue #26 [0003]: a new driver takes "10–15 min to appear" — root cause: `getTripFilterOptions()`
is loaded once, server-side, on each of NINE pages and passed as a static prop; trip data polls,
the option lists never do, so an open tab shows a frozen fleet until F5. Fix (constitution-aligned:
polling + focus refetch, NO Realtime):

1. **NEW BFF read** `GET /api/trips/filter-options` — `requireAuth` + `view_all_trips` (held by all
   7 internal roles; §18) → `{ options: getTripFilterOptions() }`. One permission, one shape.
2. **NEW hook** `useFilterOptions(initial: TripFilterOptions)` in `apps/web/lib/trips/client.ts` —
   TanStack Query, key `["filter-options"]`, `initialData: initial` (server seed → FR-003 no
   flash), `refetchInterval: 60_000` (`FILTER_OPTIONS_POLL_MS`), default focus-refetch on
   (FR-001). Failure keeps last data (TanStack default — FR-006).
3. **Adoption (all 9 pages — clarification 2026-07-27)**: each page keeps its server load (the
   seed); its top-level CLIENT component swaps the static prop for
   `useFilterOptions(props.…).data` at ONE spot and passes it down unchanged. Selections are IDs —
   list refreshes cannot disturb them (FR-004).

No schema/permission/write-path change; no new dependency.

## Technical Context

**Language/Version / Deps / Storage**: unchanged; no new dependency; no DDL.

**Testing**: Vitest untouched (no logic beyond a pass-through hook); Playwright — NEW
`fresh-options.spec.ts`: with a dispatch/trip-detail tab open, insert a driver via `@brazil-tms/db`,
trigger a visibility/focus refetch (fallback: wait one 60 s interval), assert the picker now offers
the driver with NO reload; regression: first-paint lists present immediately.

**Performance Goals**: one bounded query per open tab per 60 s (the same read the page load already
runs); nothing else changes.

**Constraints**: polling-only freshness (constitution); BFF-only authz; server seed keeps SSR paint.

**Scale/Scope**: 1 NEW route · 1 hook + 1 poll constant · 9 client components touch ~3 lines each ·
1 NEW e2e spec. No `NEEDS CLARIFICATION` (1 resolved).

## Constitution Check

- [x] **Simplicity (I)**: one endpoint + one hook, reused 9×; no new abstraction beyond them; pages keep their existing server loads as the seed.
- [x] **Scope (II)**: direct issue-#26 fix; no §29 gating.
- [x] **System-of-record (III)**: read-only; write paths untouched.
- [x] **Authz & secrets (IV)**: `view_all_trips` on the new read — the same key every consuming page already enforces server-side; no new exposure.
- [x] **Config over code (V)**: n/a.
- [x] **Tech constraints**: polling via TanStack Query — the mandated freshness mechanism; NO Realtime/Edge/Redis; worker untouched.
- [x] **Workflow**: branch `019-…` off `dev`; PR to `dev`; CI gates.

**Result: PASS** — no violations.

## Project Structure

### Documentation (this feature)

```text
specs/019-fresh-resource-options/
├── plan.md              # This file (research folded in — read-path-only slice)
├── spec.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
apps/web/app/api/trips/filter-options/
└── route.ts                       # NEW — GET: requireAuth + requirePermission("view_all_trips");
                                   #   { options: await getTripFilterOptions() }; force-dynamic.

apps/web/lib/trips/client.ts       # EDIT — FILTER_OPTIONS_POLL_MS = 60_000; useFilterOptions(initial):
                                   #   useQuery({ queryKey: ["filter-options"], queryFn GET,
                                   #   initialData: initial, refetchInterval }) — focus refetch is the
                                   #   TanStack default; failure keeps last data.

# Adoption — each client component swaps its static options prop for the hook ONCE at the top
# (child props unchanged; pages keep their server load as the seed):
apps/web/components/trips/control-tower-table.tsx     # EDIT — filterOptions → useFilterOptions
apps/web/components/trips/trip-detail/trip-detail-client.tsx  # EDIT — resourceOptions → hook
apps/web/components/trips/dispatch/dispatch-board.tsx # EDIT — resourceOptions → hook
apps/web/components/trips/exceptions/* (queue client) # EDIT — options → hook
apps/web/components/reports/* (reports client)        # EDIT — options → hook
apps/web/components/sla/* (sla-rules client)          # EDIT — options → hook
apps/web/components/billing/* (billing list client)   # EDIT — options → hook
apps/web/components/billing/* (rates client)          # EDIT — options → hook
apps/web/components/documents/* (doc-requirements client)  # EDIT — options → hook
                                   #   (exact file names resolved at implementation — one swap each)

apps/web/e2e/fresh-options.spec.ts # NEW — open dispatch/trip-detail; db-insert a driver; trigger
                                   #   focus/visibility refetch (fallback: one 60 s interval); the
                                   #   picker offers the driver with NO reload; first-paint regression.

# UNCHANGED: getTripFilterOptions (db read model), page server guards, assignment write path,
#   eligibility, i18n, permissions.
```

**Structure Decision**: read-path exposure + client freshness only. The nine adoption points are
mechanical one-line swaps behind the same hook — no per-page variants.

## Complexity Tracking

None.
