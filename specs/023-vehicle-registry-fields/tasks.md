---

description: "Task list for slice 023 — Vehicle Registry Fields (ANTT, Renavam, Chassi) + Form Layout"
---

# Tasks: Vehicle Registry Fields (ANTT, Renavam, Chassi) + Form Layout

**Input**: Design documents from `specs/023-vehicle-registry-fields/`

## ⚠️ Trap

This branch's generated migration is **0009**, and PR #39 (slice 022, driver CPF) ALSO carries an
0009 — whichever merges into `dev` second must regenerate/renumber its migration + snapshot during
the post-merge conflict pass. Do not "fix" this pre-merge; both branches are correct off dev.

## Tasks

- [X] T001 Branch `023-vehicle-registry-fields` off `dev` (worktree); baseline gates green.
- [X] T002 `renavamSchema` (strip → 9–11 digits) + `chassisSchema` (uppercase/strip → 17 VIN chars, no I/O/Q) in shared; `vehicleBase`: + `anttNumber` (text ≤ 20), `renavam`, `chassis`; unit cases.
- [X] T003 `packages/db/schema/vehicles.ts`: + `antt_number`, `renavam`, `chassis`; `drizzle-kit generate` → additive migration (verify no DROP).
- [X] T004 `vehicles-service.ts`: DTO/Row/toDto/insert/update-field-list + 3 fields; service round-trip test.
- [X] T005 `vehicle-form.tsx` layout (Placa|Tipo, Renavam|ANTT, Chassi|Capacidade half-width) + `vehicle-detail-client.tsx` + pt-BR keys.
- [X] T006 PRD amendments (§14 Vehicle, RES-004, §30 decision log).
- [X] T007 E2e: vehicle create fills Renavam/ANTT/Chassi; edit shows normalized values.
- [X] T008 Adversarial verification workflow over the diff; gates: lint/typecheck/vitest/build; migration applied to local pg (5433); Playwright.
- [X] T009 PR to `dev` (with the 0009-renumber note); CLAUDE.md SPECKIT block → this plan.
