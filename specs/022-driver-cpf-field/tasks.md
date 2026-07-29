---

description: "Task list for slice 022 — Driver CPF Replaces E-mail"
---

# Tasks: Driver CPF Replaces E-mail

**Input**: Design documents from `specs/022-driver-cpf-field/`

## ⚠️ Trap

Do NOT remove `email` from the Drizzle table definition — the column must stay mapped (dormant)
or the next `drizzle-kit generate` will emit a data-destroying `DROP COLUMN`. It leaves the Zod
schemas, the DTO, and the UI only.

## Tasks

- [X] T001 Branch `022-driver-cpf-field` off `dev`; baseline gates green.
- [X] T002 `cpfSchema` + `optionalCpf` in shared master-data schemas; `driverBase`: `email` → `cpf`; unit cases.
- [X] T003 `packages/db/schema/drivers.ts`: add `cpf`, mark `email` dormant; `drizzle-kit generate` → migration 0009 (additive only — verify no DROP).
- [X] T004 `drivers-service.ts`: DTO/Row/toDto/insert/update-field-list `email` → `cpf`; service test round-trip.
- [X] T005 `driver-form.tsx` + `driver-detail-client.tsx` + pt-BR catalog: CPF field replaces E-mail.
- [X] T006 PRD amendments (§14 Driver, RES-002, §30 decision log).
- [X] T007 E2e: driver create with CPF; assert no "E-mail" label on the driver form.
- [X] T008 Gates: lint/typecheck/vitest/build; migration applied to local pg (5433); Playwright vs the mock-GoTrue stack.
- [X] T009 PR to `dev`; CLAUDE.md SPECKIT block → this plan.
