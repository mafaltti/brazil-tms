---

description: "Task list for slice 020 — License/Document Expiry Visibility"
---

# Tasks: License/Document Expiry Visibility

**Input**: Design documents from `specs/020-license-expiry-visibility/`

## ⚠️ Trap

The UI must NOT re-derive the state — render `documentExpiryState` as delivered (the shared 30-day
São Paulo-calendar computation also feeds assignment eligibility; two derivations WILL drift).

## Tasks

- [X] T001 Branch `020-license-expiry-visibility` off `dev`; baseline gates green.
- [X] T002 `ExpiryState.notInformed` pt-BR key.
- [X] T003 Create `apps/web/components/master-data/expiry-cell.tsx` (four-state cell per plan).
- [X] T004 Wire it in `drivers-client.tsx` (licenseExpiry), `vehicles-client.tsx` + `trailers-client.tsx` (documentExpiry).
- [X] T005 Create `apps/web/e2e/expiry-visibility.spec.ts` (four driver states + one vehicle case).
- [X] T006 Gates: lint/typecheck/build; Playwright vs the local mock-GoTrue stack (new spec + `master-data-resources.spec.ts` regression).
- [X] T007 PR to `dev`; CLAUDE.md SPECKIT block → this plan.
