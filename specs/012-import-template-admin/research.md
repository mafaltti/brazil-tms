# Phase 0 Research: Import Template Administration

Pattern research to ground a **UI-only** slice in existing house conventions (one app, no backend change).
Each decision cites the concrete file it mirrors. Produced from a 6-scout + synthesis sweep of the
codebase; the two synthesizer claims that conflicted with source were corrected against
`packages/shared/src/auth/permissions.ts` and its test (see the Authorization decision).

## Decision: Screen location & server guard

- **Decision**: New Server Component at `apps/web/app/(shell)/admin/import-templates/page.tsx` (the
  Administration route group, following `admin/customers/page.tsx`). Guard with the canonical pattern
  `const session = await verifySession(); if (!session.authenticated) redirect('/login'); if
  (!can(session.user.role, 'import_trips')) redirect('/')`. It renders the client screen. **No
  `[id]/page.tsx`** — list + create + edit live on one page.
- **Rationale**: This is the exact guard every shipped `(shell)` page uses (`imports/page.tsx`). FR-011
  places the screen in Administration; it is also linked from `/imports`. A single customer-scoped page is
  the minimal shape.
- **Alternatives**: `/imports/templates` (rejected — FR-011 says Administration); a `[id]/page.tsx`
  detail route (rejected — extra route + second guard for no benefit); `requireAuth()/requirePermission()`
  in the page (rejected — those throw and are for `route.ts`; pages redirect).

## Decision: Data-access layer (dedicated client, not the master-data client)

- **Decision**: New `apps/web/lib/imports/import-templates-client.ts` with typed fetch helpers + TanStack
  Query hooks against `/api/import-templates` and `/api/import-templates/:id`
  (list `?customerId=&includeArchived=`, get, create POST, update/archive/activate PATCH). It reads the
  error code from `body.error.code` and surfaces `DUPLICATE_TEMPLATE`. Query key
  `['import-templates', customerId, { includeArchived }]`, ~30s `staleTime`.
- **Rationale**: `lib/master-data/client.ts` hardcodes `basePath = /api/master-data/${entity}` and cannot
  address `/api/import-templates` (no such master-data route exists). `trip-import-client.tsx` already
  fetches `/api/import-templates` directly — that is the precedent. Response envelope is `{items}`/`{item}`
  and errors are `{error:{code,message}}` via `handleRouteError`.
- **Alternatives**: reuse `useEntityList/createEntity` (rejected — wrong hardcoded base → 404); inline all
  fetches in the component (workable but the screen has 6 operations; a thin module keeps it readable and
  is unit-testable under `lib/**`); add a `/api/master-data/import_templates` alias (rejected — backend
  change).

## Decision: Form stack — react-hook-form + zodResolver(templateConfigSchema) + .superRefine

- **Decision**: `import-template-form.tsx` uses `useForm<TemplateConfig>` + `zodResolver` over the **shared**
  `templateConfigSchema`, extended with `.superRefine` for the two UI-only rules the backend does not
  enforce: (1) **no duplicate `target`** across `columnMappings` rows (issue on the offending row); (2) a
  **non-blocking warning** when a row's `target` ∈ `MAPPED_DATE_FIELDS` but `parsingRules.dateFormats` is
  empty (FR-015). `useFieldArray` for the mapping rows; native `<input type="checkbox">` for the per-row
  `required` flag (no shadcn Switch/Checkbox exists). Mirrors `components/master-data/customer-form.tsx`.
- **Rationale**: `customer-form.tsx` is the exact precedent (RHF + zodResolver + useFieldArray +
  `EntityFormShell`/`Field`). Reusing `templateConfigSchema` keeps ONE validation boundary (the route
  re-validates the same schema). Duplicate-target / missing-date-format have no backend guard, so
  `.superRefine` on the form schema is the DRY home for them.
- **Alternatives**: plain `useState` (rejected — breaks the RHF pattern, loses field errors); a separate
  client schema duplicating the contract (rejected — drift); imperative onSubmit checks (rejected — no
  per-row inline errors, not reusable by the unit test).

## Decision: Target-field picker — grouped single-select from the shared MAPPED_*_FIELDS

- **Decision**: Render the per-mapping target with the existing `SelectGroup` + `SelectLabel` + `SelectItem`
  primitives (`components/ui/select.tsx`), four groups whose options are spread from `MAPPED_STRING_FIELDS`
  / `MAPPED_DATE_FIELDS` / `MAPPED_NUMBER_FIELDS` / `MAPPED_JSON_FIELDS` imported from `@brazil-tms/shared`.
  Group headers from i18n (`ImportTemplates.fieldGroups`: Texto / Data e Hora / Número / Estruturado).
  Never hardcode field names. No free-text; no search (YAGNI at ~16 fields).
- **Rationale**: `MAPPED_*_FIELDS` are the single source of truth the engine uses for cell coercion
  (`packages/shared/src/schemas/import.ts:100-124`); deriving the picker from them means a future field
  appears with zero UI change (Constitution V). `SelectGroup`/`SelectLabel` are already exported.
- **Alternatives**: flat select (rejected — FR-003 requires kind grouping); hardcoded list (rejected —
  drifts from the engine); free-text target (rejected — the picker must constrain, the engine silently
  ignores unknown targets).

## Decision: Confirmations & archived read-only (client-side)

- **Decision**: The FR-017 last-active-template warning and the archive confirmation use the existing
  `Dialog` primitive (`components/ui/dialog.tsx`) — controlled `open` state, `Cancelar`/`Prosseguir`,
  **warn-and-allow** (non-blocking). The last-active condition is computed from the already-loaded,
  customer-scoped list (count of `active && !archived` dropping to zero). FR-010 (archived not editable) is
  enforced **client-side**: archived rows expose no Edit/activate/deactivate/archive action and open a
  read-only inspection view; archived rows show only when the `includeArchived` toggle is on.
- **Rationale**: No `AlertDialog` component exists; `Dialog` is the established confirmation surface. The
  frozen `updateTemplate` has **no `archivedAt` guard** (confirmed — it accepts config PATCHes on archived
  rows), so the read-only rule must live in the UI.
- **Alternatives**: add shadcn `AlertDialog` (rejected — durable addition for a one-off); `window.confirm`
  (rejected — not pt-BR/testable); block outright (rejected — FR-017 is warn-and-allow); rely on a backend
  archived guard (rejected — none exists and adding one is a frozen-backend change).

## Decision: "Criar nova versão" via in-memory copy

- **Decision**: A list action opens the create form **pre-filled** by copying the selected template's
  config (`columnMappings`, `parsingRules`, `fileType`, `requiredOverrides`, `customerId`, `name`) with
  id/timestamps dropped and `version` pre-set to `max(existing for customer+name) + 1` (editable). Submit
  POSTs the existing create endpoint. A collision returns the existing `DUPLICATE_TEMPLATE` 409.
- **Rationale**: Reuses the create endpoint with no backend change; max-version is read from the loaded
  list. Concurrency is last-write-wins (the DTO carries no revision token).
- **Alternatives**: a dedicated "new version" endpoint (rejected — backend frozen); `[id]/new` route
  (rejected — no `[id]` route is created).

## Decision: i18n — one `ImportTemplates` namespace; reuse existing audit-action labels

- **Decision**: Add a single top-level `ImportTemplates` namespace in `apps/web/messages/pt-BR.json`
  (sibling of `Imports`) with nested `fieldGroups`, `validation`
  (`duplicateKey`, `conflictingMapping`, `missingDateFormat`, `atLeastOneMapping`, `incompleteMapping`),
  `confirmations.lastActiveTemplate`, and flat form/title labels. Add `Nav.importTemplates` and
  `Imports.manageTemplates`. **No new audit-action keys** (the `import_template.create/.update` labels
  already exist; the frozen service writes them).
- **Rationale**: One namespace per screen is the convention (mirrors `Imports`). Keys are camelCase with
  **no dots** (next-intl's nesting separator); `lib/messages.test.ts`'s `dottedKeys()` guard enforces it.
- **Alternatives**: nest under `Imports.templates` (rejected — the screen owns its namespace); split into
  several namespaces (rejected — keep one, nest); new audit keys (rejected — none added).

## Decision: Test split — Playwright for flows/authz, lib-only Vitest for pure logic

- **Decision**: One new Playwright spec `apps/web/e2e/import-template-admin.spec.ts` covers
  create→selector integration, edit, criar-nova-versão, duplicate-409 pt-BR message, activate/deactivate,
  archive read-only, last-active warning, and authorization. Extract pure helpers (duplicate-target,
  max-version, missing-date-format) into the `lib` client module and unit-test them in
  `apps/web/lib/imports/import-templates-form.test.ts`. Extend `lib/messages.test.ts` to assert the new
  keys resolve and contain no dots. **No `route.test.ts`.**
- **Rationale**: Authorization/HTTP-status and rendered pt-BR are tested only in e2e per convention; web
  Vitest scans `lib/**` only, so logic must live in `lib` to be unit-testable.
- **Alternatives**: `route.test.ts` for 401/403 (rejected — never runs); jsdom component tests (rejected —
  not the convention); no Vitest (acceptable only if nothing is extracted).

## Decision (corrected): Authorization — `import_trips` only; archive is NOT gated by `delete_archive`

- **Decision**: The screen and **all** its actions (including archive) are gated by the existing
  **`import_trips`** key. The UI does **not** introduce a `delete_archive`/`canArchive` gate.
- **Rationale (source-verified)**: `permissions.ts` + `permissions.test.ts` confirm `import_trips` is held
  by **exactly Admin + Operations Manager** (Dispatcher/Control Tower/Finance/Executive Viewer do **not**
  hold it — correcting a synthesizer claim that Dispatcher has it). The existing import-templates **PATCH**
  endpoint — which performs archive (`{archive:true}`) and activate (`{active}`) — is gated by
  `import_trips` (`[id]/route.ts`). `delete_archive` exists but is **Admin-only** and is used for
  *master-data* archive; gating template archive by it would (a) **diverge from the frozen endpoint** (it
  allows Operations Manager), creating a UI/backend mismatch, and (b) reopen authorization the spec closed
  with "one key, no new key." So archive stays on `import_trips`.
- **Impact on tests**: the e2e **403/redirect** check uses a role that **lacks** `import_trips` — e.g.
  **Dispatcher** (or Finance/Control Tower) — not a role that has it. (The synthesizer's note to use
  fleetCoord because "dispatcher has import_trips" is wrong; Dispatcher works fine.)

## Gotchas carried into tasks/implement

- **next-intl forbids `.` in any message key** (nesting separator) — a dotted key throws `INVALID_KEY` at
  `getMessages()` and breaks **every** authenticated page render. Nested camelCase only; `messages.test.ts`
  guards it.
- **`lib/master-data/client.ts` is not reusable** — hardcoded `/api/master-data/${entity}`; use
  `/api/import-templates` directly.
- **Backend does not guard archived-template edits** — `updateTemplate` accepts config on an archived row;
  FR-010 is UI-enforced (hide actions + read-only view).
- **No optimistic-locking token** — `ImportTemplateDto` has no revision/etag; concurrent edits are
  last-write-wins by design (Out of Scope).
- **`route.ts` may export only handler names + Next config** — the new `page.tsx` must not export helpers;
  `tsc` won't catch a stray export, only `next build`.
- **Web Vitest scans `apps/web/lib/**` only** — component/route `.test.ts` never run; put logic in `lib`,
  put status/message assertions in Playwright.
- **No `AlertDialog`/`Switch`/`Checkbox` in `components/ui`** — use `Dialog` for confirmation and a native
  checkbox for the per-row `required` flag.
- **`SelectGroup`/`SelectLabel` exist but `Select` has no `groups` prop** — render one
  `<SelectGroup><SelectLabel/>{items}</SelectGroup>` per kind manually (no existing grouped-select example).
- **Error code is at `body.error.code`** (not top-level `body.code`) — map `DUPLICATE_TEMPLATE` from there.
- **Seeding order**: `db:seed:master-data` (creates DEMO-SHOPEE) before `db:seed:import`; e2e isolates via
  unique template names, not DB cleanup — don't assume the seeded template's exact mappings; fetch them.

## Open risks (for plan/tasks awareness)

- FR-017's last-active warning is computed from a polled, possibly-stale client list; under concurrency it
  may occasionally show/skip incorrectly. Acceptable — it is warn-and-allow and concurrency is
  last-write-wins.
- `MasterDataTable` (owned by 002) doesn't expose the extra row actions (activate/deactivate, criar nova
  versão); use **custom action columns in the client component** rather than modifying the shared table.
- Edit surface (Dialog vs in-page detail panel) left to implementation — the mapping editor may be tall;
  pick by form height. Either fits the no-`[id]`-route decision.
