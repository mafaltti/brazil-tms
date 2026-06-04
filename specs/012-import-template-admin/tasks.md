---

description: "Task list for Import Template Administration (slice 012)"
---

# Tasks: Import Template Administration

**Input**: Design documents from `/specs/012-import-template-admin/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/import-template-admin-ui.md, quickstart.md

**Tests**: INCLUDED — the spec + plan define a Playwright e2e suite, Vitest unit tests for extracted helpers,
and a `messages.test.ts` key guard (Constitution test focus + house convention). Test tasks are written
before the implementation they cover.

**Scope reminder**: UI + i18n + tests ONLY. **No** file under `packages/db`, `packages/shared`,
`workers/`, or any migration directory is created or modified (data-model delta = NONE; FR-016). The
backend (`import_templates` table, `templateConfigSchema`, `MAPPED_*_FIELDS`, `import_trips`, and the
`GET/POST /api/import-templates` + `GET/PATCH /api/import-templates/:id` endpoints) is reused unchanged.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 / US2 / US3 (Setup, Foundational, Polish carry no story label)
- All paths are repo-relative from the root.

## Requirement → Task coverage (traceability)

| Req | Tasks | Req | Tasks |
|---|---|---|---|
| FR-001 | T011, T012, T013 | FR-010 | T020 |
| FR-002 | T009, T011, T013 | FR-011 | T005, T006, T008 |
| FR-003 | T012 | FR-012 | T015, T019, T020 (frozen-service audit) |
| FR-004 | T011 | FR-013 | T008, T010 |
| FR-005 | T007 | FR-014 | T003, T022 |
| FR-006 | T015 | FR-015 | T009, T011 |
| FR-007 | T016 | FR-016 | T025 |
| FR-008 | T014, T017 | FR-017 | T018, T021 |
| FR-009 | T019 | | |

**Success criteria**: SC-001 → T010/T013/T024 · SC-002 → T009/T010/T012 · SC-003 → T014/T017 ·
SC-004 → T018/T019/T020 · SC-005 → T024 · SC-006 → T024 (+T015/T019/T020) · SC-007 → T008/T010 ·
SC-008 → demonstrated in T024 (UX target, not a coded gate).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the environment; no project init or new dependency is needed (existing monorepo).

- [X] T001 [P] Confirm the required deps are already present in `apps/web/package.json` (react-hook-form, `@hookform/resolvers`, `@tanstack/react-query`, `next-intl`, and the shadcn `Select`/`SelectGroup`/`SelectLabel`, `Dialog`, `Table` primitives under `apps/web/components/ui/`). Expect NO install — if anything is missing, stop and reconcile with the plan (the plan assumes zero new deps).
- [~] T002 [P] Verify the local demo/e2e data path per `quickstart.md`: `db:seed` → `db:seed:master-data` (creates DEMO-SHOPEE) → `db:seed:import` (seeds one template) run cleanly against the local DB.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared screen scaffolding every user story builds on — data-access layer, i18n, nav, the
guarded page, the list shell, and the cross-link. No story-specific actions yet.

**⚠️ CRITICAL**: No user story work begins until this phase is complete.

- [X] T003 [P] Add the `ImportTemplates` i18n namespace to `apps/web/messages/pt-BR.json` (sibling of `Imports`): nested `fieldGroups` {`text`,`dateTime`,`number`,`structured` = Texto / Data e Hora / Número / Estruturado}, `validation` {`duplicateKey`,`conflictingMapping`,`missingDateFormat`,`atLeastOneMapping`,`incompleteMapping`}, `confirmations` {`lastActiveTemplate`}, plus flat title/subtitle/form-label/action keys. Also add `Nav.importTemplates` and `Imports.manageTemplates`. camelCase keys, NO dots; add NO new audit-action keys. **Validation-key roles** (so none is dead): `duplicateKey` = the `(customer,name,version)` 409 message; `conflictingMapping` = the **blocking** duplicate-target hint; `atLeastOneMapping` = the ≥1-mapping error; `incompleteMapping` = the pt-BR label for the **blocking** base-schema empty-`source`/`target` field error (NOT a separate rule); `missingDateFormat` = the **non-blocking** date-target-without-format warning (FR-015).
- [X] T004 [P] Create the data-access + pure-helper module `apps/web/lib/imports/import-templates-client.ts`: typed fetch helpers for `/api/import-templates` (list `?customerId=&includeArchived=`, get) and `/api/import-templates/:id` (create POST, update/archive/activate PATCH) reading the error code from `body.error.code`; TanStack Query hooks (queryKey `['import-templates', customerId, { includeArchived }]`, ~30s staleTime) + mutations that `invalidateQueries`; and exported pure helpers `findDuplicateTargets(mappings)`, `nextVersion(list, name)`, `hasDateTargetWithoutFormat(config)`. (Mirrors `trip-import-client.tsx`'s fetch pattern; does NOT use `lib/master-data/client.ts`.)
- [X] T005 [P] Add the sidebar entry to `apps/web/lib/nav.ts`: `{ key: 'importTemplates', href: '/admin/import-templates', permission: 'import_trips', icon: <existing lucide icon> }` so nav is permission-gated.
- [X] T006 [P] Add a "Gerenciar modelos" `Button asChild > Link` to `/admin/import-templates` in the header of `apps/web/components/imports/trip-import-client.tsx` (next to the history link). (FR-011)
- [X] T007 Create the client screen shell `apps/web/components/imports/import-templates-client.tsx` (`'use client'`): customer selector (reuse the `/api/master-data/customers` query, key `['master-data','customers']`), a per-customer template list table (name, version, file type, active/archived badges) fed by the list hook from T004, with pt-BR loading/empty/error states. Action buttons are placeholders here (filled per story). (depends on T004)
- [X] T008 Create the guarded Server Component page `apps/web/app/(shell)/admin/import-templates/page.tsx`: `verifySession()` → redirect `/login` if unauthenticated; `can(session.user.role,'import_trips')` → redirect `/` if denied; render `<ImportTemplatesClient />`. Export ONLY the default page component (no helpers — `next build` enforces this). (depends on T007)

**Checkpoint**: The screen is reachable from nav + `/imports`, gated by `import_trips`, and lists a
customer's templates. No mutations yet.

---

## Phase 3: User Story 1 - Author a customer's import template in-app (Priority: P1) 🎯 MVP

**Goal**: An authorized user creates a template (name, version, file type, ≥1 column mapping, parsing
rules) and it becomes selectable on the Trip Import screen.

**Independent Test**: Create a template for DEMO-SHOPEE with ≥1 mapping → it appears in the admin list and
in the `/imports` "Modelo" selector; the target picker shows the four pt-BR kind groups; a duplicate
target or zero mappings is blocked.

### Tests for User Story 1 ⚠️ (write first, ensure they FAIL)

- [X] T009 [P] [US1] Unit-test the extracted pure helpers in `apps/web/lib/imports/import-templates-form.test.ts` (Vitest): `findDuplicateTargets` flags two rows with the same target **and the N>2 case (≥3 rows sharing a target → every conflicting row flagged)**; `nextVersion` returns max(existing for customer+name)+1; `hasDateTargetWithoutFormat` is true when a `MAPPED_DATE_FIELDS` target is mapped and `parsingRules.dateFormats` is empty. (No `incomplete-row` helper — an empty `source`/`target` is caught by the base `columnMappingSchema`.)
- [X] T010 [US1] Create the Playwright spec `apps/web/e2e/import-template-admin.spec.ts` with US1 + authorization cases: (a) create a uniquely-named template for DEMO-SHOPEE with ≥1 mapping → 201, appears in the admin list AND in the `/imports` selector; (b) the grouped target picker renders the four pt-BR group headers; (c) two rows with the same target block save with an inline pt-BR hint; (d) zero mappings cannot be saved; (e) **authz**: a role WITHOUT `import_trips` (use **Dispatcher**) gets 403 on GET+POST `/api/import-templates` and is redirected away from `/admin/import-templates`. Use timestamped names for isolation.

### Implementation for User Story 1

- [X] T011 [US1] Build the shared form `apps/web/components/imports/import-template-form.tsx`: `useForm<TemplateConfig>` + `zodResolver(templateConfigSchema.superRefine(...))` adding the UI-only rules — (1) **blocking**: push an issue on **each** row whose `target` duplicates another (via `findDuplicateTargets`) → inline pt-BR hint per conflicting row; (2) **non-blocking**: a warning when `hasDateTargetWithoutFormat` (FR-015), surfaced on submit/validate (not keystroke), the user MAY still save. An empty `source`/`target` row is already a **blocking** field error from the base schema (pt-BR label `incompleteMapping`) — no extra rule. Fields: `name`/`version`/`fileType` (register), `columnMappings` via `useFieldArray` (source `Input` + the grouped target `Select` + native `<input type="checkbox">` for `required`), and a parsing-rules section pre-filled with `America/Sao_Paulo` / `,` / `.` and **`dateFormats` empty**. Reuse `EntityFormShell`/`Field` from `components/master-data/entity-form.tsx`. (depends on T004)
- [X] T012 [US1] Inside the form (T011), render the **grouped target single-select** with one `SelectGroup`+`SelectLabel` per kind, options spread from `MAPPED_STRING_FIELDS` / `MAPPED_DATE_FIELDS` / `MAPPED_NUMBER_FIELDS` / `MAPPED_JSON_FIELDS` imported from `@brazil-tms/shared`, group headers from `ImportTemplates.fieldGroups`; bind via RHF `Controller`. Never hardcode field names. (same file as T011 → after T011)
- [X] T013 [US1] Wire the "Novo modelo" create flow in `import-templates-client.tsx`: open the form in a `Dialog` (or in-page panel), submit via the create mutation (T004), show the pt-BR success state, and invalidate the list query so the new row appears. Block submit on duplicate targets / zero mappings (surface the inline pt-BR hints). (depends on T011, T012, T007)

**Checkpoint**: Create works end-to-end — the MVP. T009 + the US1 portions of T010 pass.

---

## Phase 4: User Story 2 - Review, edit, and version existing templates (Priority: P2)

**Goal**: View/edit a template, create a new version (pre-filled), and get a specific pt-BR message on a
duplicate `(customer, name, version)`.

**Independent Test**: Edit a mapping and save (persists); "Criar nova versão" opens the form pre-filled
with version=max+1; saving a duplicate `(customer,name,version)` shows "Já existe um modelo com esse nome
e versão." (not a generic error).

### Tests for User Story 2 ⚠️

- [X] T014 [US2] Extend `apps/web/e2e/import-template-admin.spec.ts` with US2 cases: edit a mapping → save → refetch shows the change; "Criar nova versão" opens the form pre-filled with version = max+1 (editable) and saving creates a distinct version (both listed); creating a duplicate `(customer, name, version)` yields a 409 and the exact pt-BR message `Já existe um modelo com esse nome e versão.`. (same file as T010 → after T010)

### Implementation for User Story 2

- [X] T015 [US2] Add edit-in-place to `import-templates-client.tsx`: open a non-archived template in the shared form (T011) seeded from its current config, save via the update PATCH mutation (config fields only), and invalidate. (depends on T011, T013)
- [X] T016 [US2] Add the "Criar nova versão" list action in `import-templates-client.tsx`: copy the selected template's config (drop id/createdAt/updatedAt), set `version = nextVersion(list, name)` (editable), open the create form pre-filled, and POST the existing create endpoint. (depends on T013; uses `nextVersion` from T004)
- [X] T017 [US2] In the create/edit flows, map the `DUPLICATE_TEMPLATE` code (read from `body.error.code` by the T004 client) to the `ImportTemplates.validation.duplicateKey` pt-BR message and surface it on the form (never a generic failure). (depends on T013, T015)

**Checkpoint**: US1 + US2 work. T014 passes.

---

## Phase 5: User Story 3 - Control which templates are available for import (Priority: P3)

**Goal**: Activate/deactivate (controls selector visibility), archive (soft-delete, read-only), with a
warn-and-allow confirmation when an action would leave a customer with zero active templates.

**Independent Test**: Deactivate → leaves the `/imports` selector; reactivate → returns; archive → hidden
from the default list (visible only with the includeArchived toggle) and shows NO Edit action;
deactivating/archiving the last active template shows a pt-BR confirmation and allows Prosseguir.

### Tests for User Story 3 ⚠️

- [X] T018 [US3] Extend `apps/web/e2e/import-template-admin.spec.ts` with US3 cases: deactivate → disappears from the `/imports` selector; reactivate → returns; archive → hidden from the active list, visible with "Incluir arquivados", and exposes NO Edit action (read-only); deactivating/archiving a customer's last active template shows the pt-BR last-active confirmation and Prosseguir proceeds. (same file as T014 → after T014)

### Implementation for User Story 3

- [X] T019 [US3] Add the activate/deactivate row action to `import-templates-client.tsx` (update PATCH `{ active }`) + invalidate; rely on the existing server-side filter so only `active && !archived` templates appear in the Trip Import selector. (depends on T007, T004)
- [X] T020 [US3] Add the archive row action (PATCH `{ archive: true }`) and the `includeArchived` toggle (passed to the list hook) in `import-templates-client.tsx`; enforce **archived = read-only client-side**: for `archived` rows render no Edit/activate/deactivate/archive actions and open a read-only inspection view (the backend has no archived guard). (depends on T007, T015)
- [X] T021 [US3] Add the FR-017 last-active warning: a controlled `Dialog` (Cancelar / Prosseguir, pt-BR `confirmations.lastActiveTemplate`) shown before a deactivate or archive that would drop the customer's `active && !archived` count to zero (computed from the loaded list); warn-and-allow (Prosseguir proceeds). Reuse one Dialog for both actions. (depends on T019, T020)

**Checkpoint**: All three stories independently functional. T018 passes.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T022 [P] Extend `apps/web/lib/messages.test.ts` to assert the new keys resolve to non-empty strings and contain no dots: `ImportTemplates.fieldGroups.*`, `ImportTemplates.validation.*`, `ImportTemplates.confirmations.lastActiveTemplate`, `Nav.importTemplates`, `Imports.manageTemplates` (rely on the existing `dottedKeys()` guard).
- [X] T023 Run `pnpm lint` + `pnpm typecheck` + `pnpm build`; fix issues — especially confirm `page.tsx` exports only the default component (no stray exports; `tsc` won't catch it, `next build` will) and that next-intl renders authenticated pages (no INVALID_KEY). **Done: lint clean, typecheck clean, `next build` succeeds (route `(shell)/admin/import-templates/page` in the manifest).**
- [X] T024 Run the full `quickstart.md` validation: seed → demo US1/US2/US3 → run the Playwright spec against a fresh build with `--workers=1`; confirm SC-001…SC-008. **Done against the live local stack (Supabase compose up; DB on :5433): migrate + seed (admin/e2e-accounts/master-data/import) → clean `next build` → `next start` → `playwright test import-template-admin --workers=1` = 13/13 PASS. Covers SC-001 (create→selector), SC-002 (constrained target + dup-target block), SC-003 (exact pt-BR dup-key message), SC-004 (deactivate/reactivate selector), SC-007 (Dispatcher 403 + redirect). Regression check (authz/permission-coverage/trip-import) = 38/38 PASS. NOTE: SC-005 (full author→upload-file→trips chain) and SC-006 (assert an `audit_logs` row) were NOT added as combined automated assertions in this spec — the `import_template.create/.update` audit rows are written by the frozen service and the upload→batch path is covered by the existing `trip-import.spec` (passed); a future combined assertion would close them explicitly.**
- [X] T025 [P] Verify the working-tree diff touches NO file under `packages/`, `workers/`, or any migration directory (the FR-016 "zero durable additions" guarantee; data-model delta = NONE). **Done: slice touches only `apps/web/**` + `specs/012/**` + the CLAUDE.md/feature.json planning pointers.**
- [X] T026 Prepare the PR to `dev` (PR template: principle(s) applied — Simplicity/Config-over-code/no durable additions; how to test). Do NOT merge to `main`; note that real per-customer template content stays BLOCKED on PRD §29 Input #1.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)**: no dependencies.
- **Foundational (P2)**: after Setup. **Blocks all user stories.** Within P2: T003, T004, T005, T006 are `[P]` (distinct files); T007 needs T004; T008 needs T007.
- **User Stories (P3–P5)**: all start after Foundational. They are independently *testable*, but US1→US2→US3 are partly **sequential in implementation** because they edit the same two files (`import-templates-client.tsx` and the single e2e spec `import-template-admin.spec.ts`). Recommended order: US1 (MVP) → US2 → US3.
- **Polish (P6)**: after the desired stories are complete (T022/T025 can run as soon as their inputs exist).

### Shared-file note (why some story tasks are NOT [P])

- `apps/web/components/imports/import-templates-client.tsx` is grown by T007 → T013 → T015/T016/T017 → T019/T020/T021 (sequential).
- `apps/web/e2e/import-template-admin.spec.ts` is grown by T010 → T014 → T018 (sequential).
- `apps/web/components/imports/import-template-form.tsx` is T011 → T012 (same file).

### Within each story

- Tests (T009/T010, T014, T018) are written first and must FAIL before implementation.
- Form (T011/T012) before the create wiring (T013) that uses it.
- Create (US1) before edit/version (US2) before lifecycle (US3) where they share the client file.

### Parallel opportunities

- Setup: T001, T002 in parallel.
- Foundational: **T003, T004, T005, T006 in parallel** (i18n json, client lib, nav, trip-import link — all distinct files); then T007, then T008.
- US1: T009 (unit test, own file) in parallel with starting T010 (e2e, own file).
- Polish: T022 and T025 in parallel.

---

## Parallel Example: Foundational

```bash
# After Setup, launch the four independent foundational files together:
Task: "T003 Add ImportTemplates i18n namespace in apps/web/messages/pt-BR.json"
Task: "T004 Create apps/web/lib/imports/import-templates-client.ts (helpers + hooks)"
Task: "T005 Add nav entry in apps/web/lib/nav.ts"
Task: "T006 Add 'Gerenciar modelos' link in apps/web/components/imports/trip-import-client.tsx"
# Then: T007 (client shell, needs T004) → T008 (guarded page, needs T007)
```

---

## Implementation Strategy

### MVP first (User Story 1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational (CRITICAL — blocks stories) → 3. Phase 3 US1.
4. **STOP & VALIDATE**: an Operations user can author a template in-app and it appears in the Trip Import
   selector for a customer that had none (SC-001, SC-005) — the core CUST-003 gap is closed.
5. Demo / open PR if stopping at MVP.

### Incremental delivery

- Foundational ready → **US1 (MVP)** → US2 (edit/version/duplicate) → US3 (lifecycle) → Polish. Each story
  adds value without breaking the previous; the single PR targets `dev`.

---

## Notes

- `[P]` = different files, no incomplete dependency. The single-screen nature means most story tasks share
  `import-templates-client.tsx` / the e2e spec and so are sequential — this is expected and called out above.
- This slice writes **zero** durable surface (FR-016 / T025). If any task seems to require a backend,
  schema, permission-key, or worker change, STOP — it is out of scope and signals a design drift.
- Commit after each task or logical group; PR base is `dev`; AI must not merge to `main`.
