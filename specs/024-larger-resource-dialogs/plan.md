# Implementation Plan: Larger Resource Registration Dialogs

**Branch**: `024-larger-resource-dialogs` | **Date**: 2026-07-28 | **Spec**: [spec.md](./spec.md)

## Summary

Issue #31 [0008]: the driver/vehicle/trailer create dialogs are cramped at the base `max-w-lg`
(512px). Presentation-only fix: the three `DialogContent`s get `max-w-4xl` (896px) +
`max-h-[90vh]` via `className` (tailwind-merge in `cn()` resolves the `max-w` conflict with the
base). Forms inside are untouched — their `sm:grid-cols-2` pairs widen naturally.

## Technical Context

**Testing**: new `apps/web/e2e/dialog-size.spec.ts` measuring each dialog's `boundingBox().width`
≥ 850px at the default 1280px viewport (old width was 512px); existing
`master-data-resources.spec.ts` as the functional regression inside the larger dialogs. No Vitest
change (no logic).

**Everything else**: unchanged. NOTE: no overlap with PR #39 (022, driver-form field swap) or
PR #40 (023, vehicle-form regroup) — this slice touches only the three `*s-client.tsx` dialog
containers, so all three PRs merge independently.

## Constitution Check

- [x] **Simplicity (I)**: three one-line `className` edits; no abstraction (a shared width constant for 3 uses is not warranted — the literal is the simplest form).
- [x] **Scope (II)**: direct issue-#31 fix; tabbed/3-col redesign, other dialogs, edit pages out of scope.
- [x] **System-of-record (III) / Authz (IV) / Config (V) / Tech constraints**: untouched (presentation only).
- [x] **Workflow**: branch `024-…` off `dev`; PR to `dev`; CI gates.

**Result: PASS.**

## Project Structure

```text
apps/web/components/master-data/
├── drivers-client.tsx   # EDIT — DialogContent className: max-h-[90vh] max-w-4xl overflow-y-auto
├── vehicles-client.tsx  # EDIT — same
└── trailers-client.tsx  # EDIT — same

apps/web/e2e/dialog-size.spec.ts  # NEW — the three dialogs measure ≥ 850px at 1280px viewport

# UNCHANGED: forms, ui/dialog.tsx base, other master-data dialogs, detail pages.
```

## Complexity Tracking

None.
