# Feature Specification: Import Template Administration

**Feature Branch**: `012-import-template-admin`

**Created**: 2026-06-03

**Status**: Draft

**Input**: User description: "Create a Spec Kit feature spec for 012 - Import Template Administration (configure customer import templates in-app). A corrective close-out slice that completes CUST-003, which slice 004 shipped only as a BFF API + worker — never a user-facing screen. UI-only; no durable additions."

## Context & Scope Boundary *(mandatory)*

This is a **corrective close-out slice** in the spirit of 009/010/011: a new numbered slice that
**completes a requirement an earlier shipped slice owned but left unfinished**. It does **not** edit
shipped specs; it references them.

- **The gap**: `CUST-003` ("Users can configure customer-specific import templates", MVP) is assigned
  to Feature **004** in the ownership matrix (`docs/SPEC-SLICING.md`). Feature 004 shipped the durable
  half — the `import_templates` entity (PRD §14), the config-driven engine (Constitution V), the
  template service, and the full BFF endpoint surface (list / detail / create / update / archive) — but
  **never the screen that lets a user exercise it**. Today a template can only be created by a developer
  running a seed script or hand-crafting an API payload. For every customer without such a seed, the
  Trip Import screen shows "Nenhum modelo ativo para este cliente" and no file can be imported.
- **This slice closes that gap with a screen, and nothing else.**
- **Data-model changes: NONE.** **Durable additions: NONE** — no new table, column, enum, migration,
  permission key, worker job, package, or runtime dependency. The `import_templates` entity, the
  template config contract, and the existing endpoints are **reused as-is**.
- **New work is UI + i18n + tests only.** It MUST NOT re-implement the import engine or the template
  config shape (Constitution V — one config-driven engine, never per-customer code).
- **Builds on**: `specs/004-trip-import-validation/` (the Import Template entity, config-driven engine,
  template endpoints, and the Trip Import screen + selector this slice feeds), and `001`'s
  `import_trips` permission + Administration shell.

## Clarifications

### Session 2026-06-03

- Q: How does a user create a NEW VERSION of an existing template? → A: A "Criar nova versão" action on
  the per-customer template list opens the **create form pre-filled** from the selected template (version
  pre-set to highest existing + 1, editable); the edit form stays single-purpose and the existing create
  endpoint is reused unchanged.
- Q: Which control renders the constrained, kind-grouped target-field picker (FR-003)? → A: A **grouped
  single-select** consistent with the existing Trip Import selector control, with one group header per
  kind (Texto / Data e Hora / Número / Estruturado), options bound to the shared recognized-field set; no
  free-text entry and no search (unnecessary at the current ~16 fields).
- Q: When deactivating OR archiving a customer's LAST available (active, non-archived) template, what
  happens? → A: **Warn and allow for BOTH actions** — a pt-BR confirmation explains that imports for that
  customer will be blocked; the user may proceed. The existing "Nenhum modelo ativo" Trip Import state is
  the downstream safety net.
- Q: How does the UI handle an attempt to edit an ARCHIVED template? → A: The **Edit action is not
  offered** for archived templates (view-only inspection); the rule is enforced UI-side, since the
  existing backend does not reject edits to archived rows and is unchanged this slice.
- Q: In the column-mapping editor, are duplicate/conflicting target mappings prevented before save? → A:
  **Yes** — the editor prevents saving when the same target field is mapped by more than one row, with an
  inline pt-BR hint on the conflicting rows (pure client-side rule; the shared schema is unchanged).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Author a customer's import template in-app (Priority: P1)

An Operations administrator opens the Import Templates screen, selects a customer, and defines a
template: a name, a version, the file type (CSV or spreadsheet), the column mappings (each file column
mapped to a recognized internal trip field, optionally marked required), and the parsing rules (date
formats, timezone, decimal/thousand separators). On save, the template is stored for that customer and
becomes selectable on the Trip Import screen.

**Why this priority**: This is the entire reason the slice exists — it converts CUST-003 from a
developer-only capability into a self-service Operations capability. Delivered alone, it already removes
the hard blocker (a customer with no template can never import) and is a viable MVP.

**Independent Test**: Signed in as an authorized user, create a template for a customer that has none,
then open `/imports`, select that customer, and confirm the new template appears in the "Modelo"
selector and an upload using it produces a validated batch.

**Acceptance Scenarios**:

1. **Given** a customer with no templates, **When** an authorized user fills in name, version, file
   type, at least one column mapping, and saves, **Then** the template is created and the success state
   is shown in pt-BR.
2. **Given** the new template is active, **When** the user opens the Trip Import screen and selects that
   customer, **Then** the template appears in the "Modelo" selector.
3. **Given** the column-mapping editor, **When** the user adds a mapping row, **Then** the target field
   is chosen from a constrained grouped single-select of recognized internal fields (no free-text target
   is possible).
4. **Given** the parsing-rules section, **When** the form opens, **Then** timezone (`America/Sao_Paulo`),
   decimal separator (`,`) and thousand separator (`.`) are pre-filled with the documented defaults and
   remain editable.
5. **Given** the column-mapping editor with the same target field selected on two rows, **When** the user
   tries to save, **Then** the save is blocked with an inline pt-BR hint on the conflicting rows.

---

### User Story 2 - Review, edit, and version existing templates (Priority: P2)

An authorized user views the list of a customer's templates, opens one to inspect its mappings and
rules, edits it, or creates a new version when the customer's file format changes — and is shown a clear
message if the (customer, name, version) they chose already exists.

**Why this priority**: Customer file formats change over time; without edit/version the screen is a
one-shot tool. Depends on US1 existing but is independently testable against a seeded template.

**Independent Test**: Open a seeded template, change a mapping and save; then attempt to create a
template with a (customer, name, version) that already exists and confirm a specific pt-BR duplicate
message is shown rather than a generic failure.

**Acceptance Scenarios**:

1. **Given** a customer with one or more templates, **When** the user opens the screen for that customer,
   **Then** each template is listed with name, version, file type, and active/archived state.
2. **Given** an existing non-archived template, **When** the user edits its mappings/rules and saves,
   **Then** the changes persist and are reflected on reload.
3. **Given** an existing template, **When** the user chooses "Criar nova versão" on its list row, **Then**
   the create form opens pre-filled (version set to highest + 1, editable), and saving it creates a
   distinct version so both versions are listed.
4. **Given** a (customer, name, version) that already exists, **When** the user tries to save it, **Then**
   a specific pt-BR message identifies the duplicate (the form does not degrade to a generic error).

---

### User Story 3 - Control which templates are available for import (Priority: P3)

An authorized user activates/deactivates a template (controlling whether it appears in the Trip Import
selector) and archives a template that is no longer used (retiring it from the list and the selector).

**Why this priority**: Lifecycle control keeps the import selector clean as templates accumulate. Useful
but not required to unblock the first import, so it is the lowest of the three.

**Independent Test**: Deactivate an active template and confirm it disappears from the Trip Import
selector; reactivate it and confirm it returns; archive a template and confirm it leaves the default list
and the selector and offers no Edit action.

**Acceptance Scenarios**:

1. **Given** an active template, **When** the user deactivates it, **Then** it no longer appears in the
   Trip Import selector for that customer.
2. **Given** a deactivated template, **When** the user reactivates it, **Then** it reappears in the
   selector.
3. **Given** a template that is no longer needed, **When** the user archives it, **Then** it is hidden
   from the default template list and from the import selector and offers no Edit action (view-only).
4. **Given** a customer's last available (active, non-archived) template, **When** the user deactivates or
   archives it, **Then** a pt-BR confirmation warns that imports for that customer will be blocked and the
   user may proceed.

---

### Edge Cases

- **Unrecognized target field**: prevented by design — the target is a constrained grouped single-select
  sourced from the recognized-field set, so a typo'd/unknown target (which the engine would silently
  ignore) cannot be saved.
- **Duplicate target mapping**: mapping the same target field on two rows is blocked at save with an
  inline pt-BR hint on the conflicting rows (the engine would otherwise resolve duplicates invisibly).
- **Duplicate natural key**: saving an existing (customer, name, version) is rejected with a specific
  pt-BR message (the server already returns a duplicate conflict; the UI must not show a generic error).
- **No active template left**: if deactivating or archiving would leave a customer with zero active
  templates, a pt-BR confirmation (for **both** actions) warns that imports for that customer will be
  blocked; the user may proceed, and the Trip Import screen's existing "Nenhum modelo ativo" state is the
  downstream guard.
- **Editing an archived template**: the UI offers no Edit action on archived templates (view-only); the
  constraint is enforced client-side because the existing backend does not reject such edits.
- **Date target without a date format**: if a date-kind field is mapped but no date format is provided,
  the screen warns before save (those cells would fail to parse at import time).
- **At least one mapping required**: a template with zero column mappings cannot be saved.
- **No customers exist**: the customer selector is empty and the create form is disabled with guidance to
  create a customer first.
- **Unauthorized access**: a user without `import_trips` does not see the screen or its navigation entry,
  and direct navigation is denied.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Authorized users MUST be able to create an import template for a selected customer,
  specifying name, version, file type (CSV or spreadsheet), at least one column mapping, parsing rules,
  and required-field overrides. *(CUST-003, INT-002; PRD §14 Import Template, §15.3)*
- **FR-002**: The column-mapping editor MUST allow adding and removing mapping rows; each row pairs a
  **source column label** (free text matching the customer's file header) with a **target internal
  field** and an optional **required** flag. The editor MUST prevent saving when the same target field is
  mapped by more than one row, surfacing an inline pt-BR hint on the conflicting rows.
- **FR-003**: The target field MUST be selected from a **constrained list of recognized internal fields**
  (the system MUST NOT accept a free-text target), rendered as a **grouped single-select** consistent
  with the existing Trip Import selector control, with one pt-BR group header per kind (Texto / Data e
  Hora / Número / Estruturado). The option list MUST be derived from the single shared definition of
  recognized fields, not a hardcoded copy; free-text and search are not provided. *(designs out the
  "silently ignored unknown target" footgun)*
- **FR-004**: Users MUST be able to edit parsing rules: an ordered list of date formats, timezone,
  decimal separator, and thousand separator. Timezone (`America/Sao_Paulo`), decimal separator (`,`), and
  thousand separator (`.`) are pre-filled with the documented defaults; **`dateFormats` defaults to an
  empty list** (no date format pre-filled) — this is the precondition for the FR-015 date-format warning.
- **FR-005**: Users MUST be able to view a per-customer list of templates showing at least name, version,
  file type, active state, and archived state.
- **FR-006**: Users MUST be able to open and edit an existing non-archived template's mappings, parsing
  rules, and required overrides, and persist the changes. The edit form is single-purpose (it modifies
  the current template in place; it does not branch versions).
- **FR-007**: Users MUST be able to create a new version of a template (same name, higher version) as a
  distinct entry, via a **"Criar nova versão"** action on the per-customer template list that opens the
  create form **pre-filled** from the selected template (version pre-set to highest existing + 1,
  editable). The existing create endpoint is reused; no new form component is required beyond the create
  form.
- **FR-008**: When a save would collide with an existing (customer, name, version), the system MUST
  surface a specific pt-BR duplicate message rather than a generic failure.
- **FR-009**: Users MUST be able to activate and deactivate a template; only **active, non-archived**
  templates appear in the Trip Import selector.
- **FR-010**: Users MUST be able to archive a template; archived templates are hidden from the default
  list and from the import selector and are **not editable** — the UI offers **no Edit action** for an
  archived template (view-only inspection). This is enforced UI-side (the existing backend does not reject
  edits to archived rows and is unchanged this slice).
- **FR-011**: The screen MUST be reachable from the Administration area and via a "Gerenciar modelos"
  link from the Trip Import (`/imports`) screen.
- **FR-012**: Every create, edit, activate/deactivate, and archive action MUST be recorded in audit
  history attributable to the acting user (reusing the existing import-template audit actions). *(PRD
  §19.x audit; Constitution audit rules)*
- **FR-013**: Users without the `import_trips` permission MUST NOT see the screen or its navigation entry,
  and direct access MUST be denied. **Every action on the screen — including archive (FR-010) and the
  last-active flow (FR-017) — is gated by `import_trips`, matching the existing import-templates PATCH
  endpoint; the Admin-only `delete_archive` key is NOT used here.** *(PRD §12.1 — Admin + Operations Manager)*
- **FR-014**: All labels, helper text, validation messages, and confirmations MUST be pt-BR.
- **FR-015**: Before save, the screen MUST show a **non-blocking** warning when a date-kind target is
  mapped but `parsingRules.dateFormats` is empty — the user MAY still save (the warning is surfaced on
  submit/validate, not on every keystroke). A mapping row with an empty `source` or empty `target` is a
  **separate, blocking** field error already enforced by the base mapping schema (non-empty
  `source`/`target`), surfaced inline in pt-BR via the `incompleteMapping` label — it is not part of this
  non-blocking warning.
- **FR-016**: This feature MUST NOT introduce any new table, column, enum, migration, permission key,
  worker job, package, or runtime dependency; it reuses the existing Import Template entity, the existing
  template configuration contract, and the existing template endpoints unchanged. *(data-model delta =
  NONE; Constitution V)*
- **FR-017**: Before an action that would leave a customer with **zero active (non-archived) templates** —
  deactivating or archiving its last available template — the UI MUST show a pt-BR confirmation
  explaining that imports for that customer will be blocked, and MUST allow the user to proceed.

### Key Entities *(reused — none created or modified)*

- **Import Template** *(EXISTING — PRD §14)*: a per-customer configuration owning a name, version, file
  type, column mappings, parsing rules, required-field overrides, an active flag, and an
  archived/soft-delete marker, with audit timestamps. Unique per (customer, name, version). Reused
  unchanged.
- **Column Mapping** *(value within a template)*: a pairing of a source column label, a recognized target
  internal field, and an optional required flag.
- **Customer** *(EXISTING)*: the scope that owns templates; the screen always operates within one selected
  customer.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An authorized user can create a working import template for a customer entirely through the
  UI — with no developer, seed script, or manual API call — and it appears in that customer's Trip Import
  selector after one refresh.
- **SC-002**: 100% of column-mapping targets resolve to a recognized internal field; a user cannot save a
  template containing an unrecognized/typo target or the same target mapped twice.
- **SC-003**: A duplicate (customer, name, version) save attempt yields a specific, human-readable pt-BR
  message identifying the conflict in 100% of cases (never a generic error).
- **SC-004**: Deactivating or archiving a template removes it from the Trip Import selector, and
  reactivating restores it — verified end-to-end.
- **SC-005**: An end-to-end run shows an Operations user completing the full chain in-app — author a
  template → upload a file → trips created/updated — for a customer that began with no template.
- **SC-006**: Every template create/edit/state-change produces an audit record attributable to the acting
  user (verified in audit history).
- **SC-007**: A user without `import_trips` cannot reach or act on the screen (zero unauthorized actions
  succeed).
- **SC-008**: An authorized user can author a basic template (up to ~6 column mappings) in under 5 minutes
  without external instructions.

## Traceability *(acceptance → PRD)*

| Spec item | PRD requirement / section |
|---|---|
| FR-001, FR-005, FR-006, FR-007; US1, US2 | **CUST-003** (configure customer import templates) · PRD §14 (Import Template) · §15.3 (Trip Import / template selector) · §11.1 (import workflow) |
| FR-001 (per-customer, multiple customers) | **INT-002** (separate templates per customer: Shopee/DHL/ML/future) |
| FR-002, FR-003, FR-004 | PRD §14 (column mappings = source→internal field; date/number parsing rules) · §19.1 (import semantics) |
| FR-009, FR-010, FR-017; US3 | PRD §15.3 (selector consumes active templates) · §14 (template lifecycle) |
| FR-011, FR-013 | PRD §15.7 / §15.12 (Administration) · §12.1 (Import trips → Admin + Operations Manager) |
| FR-012 | PRD §19.x (audit history for critical operational changes) |
| FR-014 | Global constraint: MVP UI ships in pt-BR |
| FR-016 | Constitution V (one config-driven engine) · `docs/SPEC-SLICING.md` (bounded slice, no durable additions) |
| SC-005 | PRD §11.1 / §22 Phase 2 (import end-to-end) |

## Out of Scope / Future Enhancements

Deferred — **do not implement in this slice**:

- Auto-detecting a template from an uploaded file's headers.
- Template import/export (e.g., download/upload a template as a file).
- Dry-run / preview of a template against a sample file before saving.
- Bulk template operations (apply/clone across many customers at once).
- A dedicated `manage_templates` permission key (this slice reuses `import_trips`); per-action role
  differentiation between Admin and Operations Manager (would require a new key — out of scope).
- Un-archiving a template (archive is treated as terminal here; reactivation applies to the `active` flag,
  not to archived templates).
- Concurrent-edit conflict detection / optimistic locking (the existing template DTO carries no
  version/last-modified token, so any detection would change the frozen backend; last-write-wins is the
  forced behavior this slice).
- Backend-side rejection of edits to archived templates (the existing service has no such guard;
  enforcement is UI-side per FR-010 instead).
- API-based or email-attachment ingestion templates (PRD: Later).
- Any change to the import engine, the worker, the template configuration contract, the schema, or the
  data model; any per-customer code path.

## Assumptions

- The existing Import Template entity, the template configuration contract, and the BFF endpoints
  (list / detail / create / update / archive) are **reused unchanged**; this slice adds only UI, pt-BR
  messages, and tests.
- Authorization reuses the existing **`import_trips`** permission (Admin + Operations Manager per PRD
  §12.1); no new permission key is introduced, and the two roles are not differentiated per-action.
- **All of FR-001…FR-017 are fully deliverable and demonstrable in this slice** using documented-default /
  scaffolding values; **only** final per-customer template *content* sign-off (real Shopee / DHL eCommerce
  / Mercado Livre column names + formats) **remains BLOCKED on PRD §29 Input #1** (real sample files). No
  real customer column names or formats are invented here — mirroring Feature 004's stance.
- Editing or archiving a template affects **future imports only**; import batches already created or
  processed are unaffected. (To be confirmed in planning against how the engine reads template config per
  batch.)
- Freshness is via polling / query refetch (no Realtime), consistent with the stack.
- The recognized internal target fields presented in the picker are derived from the single shared
  definition used by the import engine (the `MAPPED_*_FIELDS` sets, exported from the shared package), so
  adding a field later requires no change to this screen.
