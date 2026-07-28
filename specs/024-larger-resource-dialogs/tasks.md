---

description: "Task list for slice 024 — Larger Resource Registration Dialogs"
---

# Tasks: Larger Resource Registration Dialogs

**Input**: Design documents from `specs/024-larger-resource-dialogs/`

## ⚠️ Trap

Do NOT touch `ui/dialog.tsx` (the base would widen EVERY dialog in the app) nor the form
components (PR #39 edits `driver-form.tsx`, PR #40 edits `vehicle-form.tsx` — touching them here
creates avoidable cross-PR conflicts). Only the three `*s-client.tsx` `DialogContent`s change.

## Tasks

- [X] T001 Branch `024-larger-resource-dialogs` off `dev` (worktree); baseline gates green.
- [X] T002 `drivers-client.tsx` + `vehicles-client.tsx` + `trailers-client.tsx`: DialogContent → `max-h-[90vh] max-w-4xl overflow-y-auto`.
- [X] T003 New `apps/web/e2e/dialog-size.spec.ts`: the three dialogs measure ~896px at the 1280px viewport (≥ 800 floor, below the enter-animation frame) + customers stays base-width; functional coverage stays in `master-data-resources.spec.ts`.
- [X] T004 Gates: lint/typecheck/build; Playwright (new spec + `master-data-resources.spec.ts` regression); visual screenshot check.
- [X] T005 PR to `dev`; CLAUDE.md SPECKIT block → this plan.
