---

description: "Task list for slice 025 — Documents Tab for Drivers and Vehicles"
---

# Tasks: Documents Tab for Drivers and Vehicles

**Input**: Design documents from `specs/025-resource-documents/`

## ⚠️ Traps

1. Do NOT touch the shipped 008 `documents` table/routes — `resource_documents` is a separate,
   append-only domain (no verification/billing semantics).
2. Validate type+size and preflight the parent (exists, not archived) BEFORE `putDocument`; roll
   the binary back if the metadata insert fails (008 pattern) — no orphans, no 500-on-FK.
3. This branch's migration is the THIRD `0009` in flight (with PRs #39/#40) — renumber-on-merge,
   never "fix" pre-merge.
4. `driver-detail-client.tsx` is also edited by PR #39 (defaultValues) — keep the tabs edit
   surgical to minimize the merge conflict.

## Tasks

- [X] T001 Branch `025-resource-documents` off `dev` (worktree); baseline gates green.
- [X] T002 DB: `resource_documents` schema + index export + `resourceDocumentStorageKey` + generated additive migration.
- [X] T003 Shared: entity-type list, upload meta schema (docType 1–60), DTO type + unit tests.
- [X] T004 Service: list (newest first) / insert+audit (tx) / fileKey lookup / parent preflight; integration tests with fake storage.
- [X] T005 Routes ×4 (drivers/vehicles list+upload, download) — 008 shape, `manage_fleet_data`.
- [X] T006 UI: shadcn `tabs.tsx` (+ `@radix-ui/react-tabs`), shared `resource-documents-tab.tsx`, tabs in the two detail clients (edit mode only), pt-BR keys.
- [X] T007 PRD amendments (§14 Driver/Vehicle, §30).
- [X] T008 Mock harness: minimal Storage endpoints in `.local/brazil-tms-dev/mock-gotrue.mjs` (outside repo); e2e `resource-documents.spec.ts` (tab → upload → history → download).
- [X] T009 Adversarial verification workflow; gates: lint/typecheck/vitest/build; migration on local pg; Playwright.
- [X] T010 PR to `dev` (0009-renumber note); CLAUDE.md SPECKIT block → this plan.
