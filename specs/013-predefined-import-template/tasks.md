# Tasks: Predefined Import Template

**Input**: Design documents from `specs/013-predefined-import-template/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/standard-import-template.md, quickstart.md

**Tests**: INCLUDED — the spec/plan and the constitution (import-validation Vitest, i18n `messages.test`, Playwright critical flows) require them. Test tasks are written before/with the code they cover.

**Organization**: Tasks are grouped by user story (US1–US3 from spec.md). This is a corrective slice that **adds nothing durable**; several files are shared across stories, so same-file tasks are sequenced (noted inline) rather than marked `[P]`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1 / US2 / US3 (setup, foundational, polish have no story label)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Make the no-template path testable.

- [X] T001 Verify the dev environment per `quickstart.md`: app (`pnpm --filter @brazil-tms/web dev`) + worker (`pnpm --filter @brazil-tms/workers dev`) running against the app DB (port 5433); seed master data only and confirm the target test customer has **no** `import_templates` row (do **not** run `db:seed:import`), so the predefined-format path is actually exercised.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared building blocks every story (and its tests) depends on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 [P] Create the `STANDARD_IMPORT_TEMPLATE` constant (typed `TemplateConfig`) in `packages/shared/src/import/standard-template.ts` — the demo mapping from `packages/db/seed/import-sample.ts` **verbatim** (columnMappings + parsingRules `dd/MM/yyyy HH:mm` / `America/Sao_Paulo` / `,` / `.`), `requiredOverrides: []`, with **inert** metadata (nil `customerId` `00000000-0000-0000-0000-000000000000`, name `"Padrão Brazil Transports (provisório)"`, `version: 1`, `fileType: "csv"`) and a comment that metadata is unused. Per `contracts/standard-import-template.md` §1.
- [X] T003 [P] Create `inferFileType(fileName): "csv" | "xlsx" | null` in `packages/shared/src/import/file-type.ts` (relocated verbatim from `apps/web/app/api/imports/route.ts`). Per `contracts/standard-import-template.md` §2.
- [X] T004 Export `STANDARD_IMPORT_TEMPLATE` and `inferFileType` from the shared package barrel(s) (`packages/shared/src/import/index.ts` and `packages/shared/src/index.ts` if the package re-exports per-module). Depends on T002, T003.
- [X] T005 [P] Add shared unit test `packages/shared/src/import/standard-template.test.ts`: assert `templateConfigSchema.parse(STANDARD_IMPORT_TEMPLATE)` succeeds, `requiredOverrides` is `[]`, and `inferFileType` returns `csv` / `xlsx` / `null` for `.csv` / `.xlsx` / other. Depends on T004.
- [X] T006 Update `apps/web/app/api/imports/route.ts` to import `inferFileType` from `@brazil-tms/shared` and **delete** the local copy (no behavior change — same extension rule, now shared). Depends on T004.

**Checkpoint**: Shared constant + canonical `inferFileType` available to both the worker and the BFF. `validate` and `createBatch` are intentionally **untouched** (validate's `loadRequiredOverrides(null)` already returns `[]`; `createBatch` already stores `template_id ?? null`).

---

## Phase 3: User Story 1 - Import a trip file with no template step (Priority: P1) 🎯 MVP

**Goal**: An operator imports by choosing only **Cliente + Arquivo**; the predefined standard format is applied automatically; no batch fails for "no template".

**Independent Test**: For a customer with no template, upload a correctly formatted CSV (and XLSX) → reaches the `validated` preview and confirms into trips in `received`, with no template control shown and no "Nenhum modelo…" failure.

- [X] T007 [P] [US1] Update `workers/jobs/parse/parse.test.ts`: add a case where `batch.templateId` is `null` → the row is mapped via `STANDARD_IMPORT_TEMPLATE` (batch does **not** go `failed`); and a `.xlsx` batch is parsed via the XLSX path chosen by `inferFileType(batch.fileName)`. (Write first; it fails until T008.) Depends on T004.
- [X] T008 [US1] Edit `workers/jobs/parse/index.ts`: replace the `if (!batch.templateId) { setBatchFailed("Nenhum modelo…") }` branch (L134-137) — when `batch.templateId` is null, use `STANDARD_IMPORT_TEMPLATE`; choose the parser via `inferFileType(batch.fileName)` instead of `template.fileType` (L165-168), failing the batch only if the inferred type is `null` (defense-in-depth; BFF already rejects unsupported). Keep the `templateId`-present path (`toTemplateConfig(row)`) intact for the dormant API. Makes T007 pass. Depends on T004.
- [X] T009 [P] [US1] Edit `apps/web/components/imports/trip-import-client.tsx`: remove the **Modelo** `Select`, the `templateId` state, the `templatesQuery`, the `/api/import-templates` fetch, the `ImportTemplate` type, and the `setTemplateId` reset on customer change; stop appending `templateId` to the upload `FormData`; keep submit gated on `customerId && file`; drop now-unused imports/strings. (Same file is extended in T012 — sequence T009 → T012.)
- [X] T010 [US1] Update e2e `apps/web/e2e/trip-import.spec.ts`: remove the template **creation** and the `templateId` from the upload form; assert a customer with **no** template imports a correctly formatted **CSV** successfully (reaches `validated` preview → confirm → trips in `received`), and the same for an **XLSX** upload (parser chosen by extension). Also assert the **FR-009 permission guard** is unchanged — `POST /api/imports` still returns **403** for a user **without** `import_trips` (and 2xx for a holder). Depends on T008, T009.

**Checkpoint**: US1 fully functional — import works with zero template steps (the MVP). Deployable on its own.

---

## Phase 4: User Story 2 - Provisional standard-format notice (Priority: P2)

**Goal**: Every operator sees a clear pt-BR notice that the standard format is a provisional documented default; dead template strings are removed.

**Independent Test**: Open `/imports` → an always-visible provisional banner is present; the upload subtitle no longer mentions "o modelo de importação".

- [X] T011 [P] [US2] Edit `apps/web/messages/pt-BR.json` (`Imports` namespace): **add** flat key `provisionalNotice` (pt-BR copy per `contracts/standard-import-template.md` §4); **rewrite** `uploadSubtitle` to `"Selecione o cliente e o arquivo a enviar."`; **remove** `template`, `selectTemplate`, `noTemplates`. Keep all keys flat (no dots).
- [X] T012 [US2] Edit `apps/web/components/imports/trip-import-client.tsx`: render an always-visible provisional banner (shadcn `Alert`) at the top of the screen using `t("provisionalNotice")`. Same file as T009 → **after T009**.
- [X] T013 [P] [US2] Update `apps/web/lib/messages.test.ts`: assert `Imports.provisionalNotice` exists; `Imports.template` / `selectTemplate` / `noTemplates` are **gone**; no dotted keys present. Depends on T011.
- [X] T014 [US2] Add an e2e assertion in `apps/web/e2e/trip-import.spec.ts` that the provisional banner is visible on `/imports`. Same file as T010 → **after T010**.

**Checkpoint**: US1 + US2 work; the screen is honest (provisional banner) and clean (no dead template UI/strings).

---

## Phase 5: User Story 3 - Visible per-row reason for non-matching files (Priority: P3)

**Goal**: A file that doesn't match the standard format surfaces the existing per-row reasons (not an unexplained failure); empty/header-only files show an empty preview. **No app-code change** — validation is unchanged (R8); this story is verification/coverage.

**Independent Test**: Upload a wrong-columns file → every data row shows `MISSING_EXTERNAL_ID`/`UNKNOWN_LOCATION` reasons in the preview + error report, no "Falhou", no header-level message; upload a header-only file → empty preview.

- [X] T015 [US3] Add e2e coverage in `apps/web/e2e/trip-import.spec.ts`: a wrong-columns file → every data row is `error` with the existing per-row reasons (visible in preview; downloadable error report); the batch is **not** `failed` and there is **no** header-level "wrong format" message; a header-only/empty file → empty preview (zero data rows). Same file as T010/T014 → **after T014**. (No source change — asserts existing slice-004 behavior under the predefined format.)

**Checkpoint**: All three stories independently verifiable.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T016 [P] Confirm no dead references remain: `template` / `selectTemplate` / `noTemplates` i18n keys and any `/api/import-templates` client call are gone from `apps/web/components/imports/`; no unused imports/types left in `trip-import-client.tsx`.
- [X] T017 [P] Run typecheck + lint + **`next build`** for `apps/web` (the build — not just `tsc` — is what catches `route.ts` export rules and next-intl key issues), plus `pnpm` typecheck for `packages/shared` and `workers`.
- [X] T018 Run the test suites green — including the **full untouched-path suites** to back **SC-006 (no regression)**, not just the changed ones: `pnpm --filter @brazil-tms/shared test`; the **entire** `pnpm --filter @brazil-tms/workers test` (validate / confirm-import / detect-duplicates / generate-error-report / parse — NOT just `parse`); the web integration suite `pnpm exec vitest run --project web` (covers `apps/web/lib/messages.test.ts` + `import-batches-service` tests); and `pnpm --filter @brazil-tms/web test:e2e -- trip-import` (prod build, `--workers=1`).
- [ ] T019 Run the `quickstart.md` manual walk (no-template CSV + XLSX import, provisional banner, wrong-format per-row reasons, empty file) and confirm the acceptance map. **(PENDING human walk — requires restarting the dev worker first so it loads the new parse code; see Completion Report. The automated equivalents — worker `parse.test.ts`, the full workers suite, `messages.test.ts`, and the e2e screen/banner/upload-acceptance flow — all pass.)**

---

## Dependencies & Execution Order

### Phase order
- **Setup (P1)** → **Foundational (P2)** blocks everything → **US1 (P3)** → **US2 (P4)** → **US3 (P5)** → **Polish (P6)**.
- US2 and US3 only *verify/extend* US1's surface; US1 alone is a shippable MVP.

### Key task dependencies
- T004 depends on T002 + T003; T005, T006 depend on T004.
- T008 depends on T004; T007 (test) is written first and passes once T008 lands.
- T010 depends on T008 + T009.
- T012 depends on T009 (same component file). T013 depends on T011. T014 depends on T010. T015 depends on T014.

### Same-file sequencing (NOT parallel)
- `apps/web/components/imports/trip-import-client.tsx`: **T009 → T012**.
- `apps/web/e2e/trip-import.spec.ts`: **T010 → T014 → T015**.
- `apps/web/messages/pt-BR.json`: single task **T011**.

### Parallel opportunities
- **T002 [P]** + **T003 [P]** (two new shared files).
- After T004: **T005 [P]** + **T006 [P]** (test file vs route file).
- Within US1: **T007 [P]** (worker test) + **T009 [P]** (UI) can proceed alongside **T008** (different files); T008 is the core impl.
- **T011 [P]** (i18n) and **T013 [P]** (messages test) are independent of the worker/UI tasks.
- Polish: **T016 [P]** + **T017 [P]**.

---

## Implementation Strategy

### MVP first (US1 only)
1. Phase 1 Setup → Phase 2 Foundational (the constant + shared `inferFileType` + parse-worker edit).
2. Phase 3 US1 → **STOP and validate**: a no-template customer imports CSV + XLSX into trips. This alone removes the silent-failure trap and the dead-end — shippable.

### Incremental delivery
3. US2 → provisional banner + dead-i18n prune (honesty/cleanup).
4. US3 → verification coverage for non-matching/empty files.
5. Polish → build/lint/test/quickstart.

---

## Notes

- **No durable additions**: no table, column (no `file_type`), enum, migration, permission, package, worker job, or dependency.
- **Intentionally untouched** (do not edit): `workers/jobs/validate/index.ts`, `apps/web/lib/imports/import-batches-service.ts` (`createBatch`), the `import_templates` table + `/api/import-templates` endpoints (dormant), `import-history-client.tsx` (history reason-visibility is a deferred follow-up), and `import.create` audit content.
- `[P]` = different files, no incomplete dependency. Commit after each task or logical group. PR targets `dev` (never `main`).
