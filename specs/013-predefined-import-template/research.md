# Research: Predefined Import Template (slice 013)

All open questions were resolved in the spec's **Clarifications** session (2026-06-06). This file
consolidates each decision with its rationale and the alternatives weighed, plus the code-grounded
findings that shape the plan. No `NEEDS CLARIFICATION` remain.

## R1 — Where the standard format lives at parse time

- **Decision**: A single in-code constant `STANDARD_IMPORT_TEMPLATE` (a `TemplateConfig`) in
  `@brazil-tms/shared` (`src/import/standard-template.ts`), holding the demo mapping **verbatim**
  (column mappings + parsing rules + `requiredOverrides: []`) as **one object**. The parse worker uses it
  whenever `batch.templateId` is `null`. `import_batches.template_id` stays null; the `import_templates`
  table is never read on the operator path.
- **Rationale**: Honors the locked "no new table/row/migration, table stays dormant, reuse the demo
  mapping verbatim". Makes FR-010's "single localized change" literally one object edit (SC-007). Direct
  precedent: slice 009 `DEFAULT_SLA_POLICY` (a labeled §29 default constant).
- **Alternatives**: (a) Seed a customer-agnostic `import_templates` row + stamp its id on every batch —
  reintroduces durable data, contradicts the dormant-table decision. (b) Sentinel `templateId` UUID
  resolving to the constant — adds a magic value for no benefit.

## R2 — CSV vs XLSX source of truth

- **Decision**: The parse worker chooses the parser from `inferFileType(batch.fileName)` (the file-name
  extension), **not** from any template attribute. The existing `inferFileType` helper is **relocated**
  from `apps/web/app/api/imports/route.ts` into `@brazil-tms/shared` (`src/import/file-type.ts`) and
  imported by both the BFF route (upload validation) and the worker (parser choice).
- **Rationale**: `ParsePayload` is `{ batchId, storageKey }` and `import_batches` has **no `file_type`
  column** (verified), while the parse worker already loads the batch row (so `batch.fileName` is in
  hand). Re-inferring from the stored file name needs no schema change, no migration, and no wider job
  payload, and keeps one canonical extension rule across upload + parse (DRY-for-correctness).
- **Alternatives**: (a) Add a `file_type` column — needs a migration (locked out). (b) Thread `fileType`
  through `ParsePayload` — widens the job contract for no gain since the file name already encodes it.

## R3 — The validate worker needs NO change (finding)

- **Decision**: Leave `workers/jobs/validate/index.ts` untouched.
- **Rationale**: Grounded in code — `loadRequiredOverrides(batch.templateId)` already returns `[]` when
  `templateId` is null (`validate/index.ts:392`), and `loadStatusLabels(batch.customerId)` is
  **customer-keyed, not template-keyed**. With `requiredOverrides` staying empty (R8), validate behaves
  identically whether or not a template exists. This is why only the **parse** worker changes.
- **Alternatives**: Passing the constant's `requiredOverrides` into validate — unnecessary (it is `[]`)
  and would touch a file the slice otherwise leaves alone.

## R4 — The BFF `createBatch` needs NO change

- **Decision**: Leave `apps/web/lib/imports/import-batches-service.ts` untouched.
- **Rationale**: `createBatch` already validates a template only inside `if (templateId)` and stores
  `templateId ?? null`. Once the client stops sending `templateId`, the existing code path stores null and
  proceeds — exactly what R1 expects. The `import_trips` gate and `import.create` audit (`{fileName,
  customerId}`, no `templateId`) are unchanged, so authz and audit-completeness are unaffected.

## R5 — Provisional notice: placement, copy, i18n

- **Decision**: An always-visible pt-BR banner at the top of the `/imports` upload screen (a shadcn
  Alert), one new flat i18n key `Imports.provisionalNotice`. Mirrors the slice-009 provisional-banner
  posture.
- **Rationale**: US2 AC1 requires the notice "when the screen is displayed" (not state-gated); a single
  persistent banner gives one stable selector for `messages.test.ts` + the US2 e2e assertion, and is the
  most discoverable placement. History screen is **out of scope** (R7), so the banner stays on upload only.
- **Copy (provisional, pt-BR)**: e.g. *"Formato de importação padrão provisório — modelo de exemplo
  pendente de confirmação do cliente; pode mudar."* (final wording owned by the i18n task; must be a flat
  key — no dots in the value path, per the next-intl rule).

## R6 — Prune dead template UI + rewrite the subtitle

- **Decision**: Remove the Modelo `Select`, the `templateId` state, the `templatesQuery`, the
  `/api/import-templates` client call, and stop appending `templateId` to the upload form. Delete the now-
  unused i18n keys `Imports.template`, `Imports.selectTemplate`, `Imports.noTemplates`. **Rewrite**
  `Imports.uploadSubtitle` (currently *"Selecione o cliente, o modelo de importação e o arquivo a
  enviar."*) to drop the template, e.g. *"Selecione o cliente e o arquivo a enviar."*
- **Rationale**: FR-001 forbids presenting a template affordance; leaving the keys is dead i18n that
  `messages.test.ts`/lint flag, and the current subtitle is actively wrong copy. FR-011 ("keep
  capabilities available") is satisfied server-side by the dormant table/API — it does not require keeping
  client strings.
- **Alternatives**: Hiding the control but keeping the keys — leaves dead i18n; KISS prefers pruning.

## R7 — History-screen failure-reason visibility is OUT of scope

- **Decision**: Do not change `import-history-client.tsx` / `ImportBatchSummary`. The history list shape
  and columns are unchanged.
- **Rationale**: Removing the no-template trap (FR-005) structurally eliminates the specific motivating
  case. Surfacing generic batch-fatal `errorMessage` on history is a broader history-UX change (list
  shape + a new "Motivo" column + i18n + tests) that exceeds "corrective simplification of 004". Tracked
  as a follow-up so tasks don't silently expand the history screen.

## R8 — Validation semantics unchanged; acceptance is documented, not re-engineered

- **Decision**: No new validation logic. A wrong-columns file surfaces the **existing per-row field-level
  reasons** (`MISSING_EXTERNAL_ID`, `UNKNOWN_LOCATION`) on every data row — **no** header-level "wrong
  format" message. `requiredOverrides` stays `[]` (no new required-column enforcement; `columnMappings[].
  required` is documentation only — the engine ignores it). `UNMAPPED_STATUS` stays a **non-blocking
  warning** (expected for customers without seeded `status_mappings`). An empty/header-only file yields an
  empty preview (zero data rows).
- **Rationale**: Locked "validation/dedup/confirm/status-mapping unchanged" + "reuse the demo mapping
  verbatim". The existing per-row path already satisfies FR-006/SC-004 ("visible per-row reasons, no
  unexplained failed batch"). A header-presence check would be new pipeline logic, out of scope.
- **Alternatives**: Add an explicit "arquivo não corresponde ao formato padrão" signal — rejected
  (new reason code/path conflicts with "validation unchanged"); revisit if Ops asks post-MVP.

## R9 — `TemplateConfig` shape of the constant

- **Decision**: Type `STANDARD_IMPORT_TEMPLATE` as a full `TemplateConfig`. The metadata fields
  (`customerId`, `name`, `version`, `fileType`) are **inert**: `applyTemplate` reads only `columnMappings`
  + `parsingRules`, and the parser is chosen by file extension (R2), so `fileType` is ignored;
  `customerId` is a fixed nil UUID with a comment that it is unused. Validate the literal once against
  `templateConfigSchema` (a unit test) so a malformed edit fails fast.
- **Rationale**: Keeps `applyTemplate`'s signature unchanged (no engine edit). Bundling all of
  `columnMappings` + `parsingRules` + `requiredOverrides` in one literal satisfies FR-010's "single
  object" so a future real-format swap is one edit (SC-007).

## R10 — No migration; the change net-reduces DB work

- **Decision**: Ship no migration. The default build adds nothing durable.
- **Rationale**: The no-template path now reads a constant instead of an `import_templates` row, so it
  does one fewer DB read than the (failing) status quo; existing indexes are untouched and adequate.
