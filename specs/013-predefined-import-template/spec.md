# Feature Specification: Predefined Import Template

**Feature Branch**: `013-predefined-import-template`

**Created**: 2026-06-06

**Status**: Draft

**Input**: User description: "Remove import-template selection from the trip-import flow. Apply ONE predefined, customer-agnostic standard import format automatically to every upload, so the operator only chooses a customer and a file. Corrective simplification of slice 004; references it, does not edit it."

## Context & Motivation

On the trip-import screen (slice 004), the operator must select an import template ("Modelo de
importação") before uploading. This is broken in three ways that compound into a silent failure:

1. **There is no way to create a template.** Template definition is not exposed in any operator-facing
   screen; in practice the only template that exists is demo scaffolding for one customer. Most
   customers therefore have **nothing to select**.
2. **The selection is inconsistent.** The upload form lets the operator submit with no template (it
   gates only on customer + file), but the import then **fails after upload** because the pipeline
   requires a template.
3. **The failure is invisible.** That post-upload failure ("no import template selected") is not shown
   on the import history screen — the operator sees only a generic "failed" status with no reason.

The result is a trap: doing exactly what the form allows produces an unexplained failed import.

Slice 004's own narrative anticipated the system *detecting* the template ("…selects, **or lets the
system detect**, that customer's import template…"), but auto-resolution was never built. This slice
closes that gap with the simplest viable answer: a **single predefined standard format** applied to
every import, removing template selection from the operator's flow entirely.

## Clarifications

### Session 2026-06-06

- Q: Where does the predefined standard format live, and how does the import worker get it (today the worker hard-fails on a null template and reads config from a DB row)? → A: A **single in-code `TemplateConfig` constant** in the shared package (column mappings + parsing rules + `requiredOverrides` as ONE object); parse and validate use it whenever the batch has no template. `import_batches.template_id` stays **null**; the `import_templates` table stays **dormant** (never read on the operator path). No DB row, no migration. FR-010's "single localized change" = editing that one object.
- Q: How does the worker decide CSV vs XLSX without a template `fileType` (there is no `file_type` column)? → A: **Re-infer from the uploaded file's name extension** in the worker, reusing the same logic the BFF already validated at upload. No `file_type` column, no migration, no wider job payload.
- Q: Where does the provisional standard-format notice appear? → A: An **always-visible pt-BR banner at the top of the upload screen** (`/imports`), mirroring the slice-009 provisional banner — one stable i18n key. The now-dead template control is **pruned** and the upload subtitle is **rewritten** to drop "o modelo de importação".
- Q: Is fixing failure-reason visibility on the import **history** screen in scope? → A: **No — out of scope / follow-up.** Removing the no-template trap (FR-005) eliminates the specific motivating scenario; surfacing other batch-fatal reasons in history is a separate, broader history-UX change (list shape + column + i18n + tests).
- Q: What does the operator see when a file does **not** match the standard format? → A: **Existing per-row reasons only** (e.g. "identificador externo obrigatório", "local de origem não informado") on every data row — there is **no header-level "wrong format" message**. `requiredOverrides` stays **empty** (no new required-column enforcement); unmapped status-label values stay **non-blocking warnings** (expected for customers without seeded status mappings); an empty/header-only file shows an **empty preview**. Validation logic is unchanged from slice 004.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Import a trip file with no template step (Priority: P1)

An operator opens the import screen, selects the customer, chooses a `.csv` or `.xlsx` file, and starts
the import. The system applies the standard import format automatically and produces the usual
validation preview (mapped rows, outcomes, match decisions). At no point is the operator asked to pick,
create, or configure a template.

**Why this priority**: This is the entire point of the slice — it removes both the dead-end (nothing to
select) and the silent-failure trap, and it is what an operator does every day. Shipping only this story
already delivers a working, trustworthy import.

**Independent Test**: With no per-customer template configured, select a customer, upload a correctly
formatted file, and confirm the import reaches the validation preview and can be confirmed into trips —
without ever interacting with a template control.

**Acceptance Scenarios**:

1. **Given** a customer with no configured template, **When** the operator uploads a correctly formatted
   `.csv`, **Then** the file is mapped against the standard format and a validation preview appears (no
   template control is shown, and the import does not fail for a missing template).
2. **Given** the same standard format, **When** the operator uploads a correctly formatted `.xlsx`,
   **Then** it is mapped and previewed identically (the file type is taken from the uploaded file).
3. **Given** a completed preview with valid rows, **When** the operator confirms, **Then** trips are
   created exactly as in slice 004 (landing in `received`), with no behavioral difference.

---

### User Story 2 - Understand that the standard format is provisional (Priority: P2)

An operator (or reviewer) needs to know that the standard import format is a **documented default**, not
a customer-signed-off contract, so successful imports are not mistaken for a validated format agreement.

**Why this priority**: Honesty/traceability requirement tied to PRD §29 (per-customer file/SLA/billing
rules are not signed off). It prevents a provisional default from being treated as final, but it does not
block the core import from working.

**Independent Test**: Open the import screen and confirm a clearly visible notice states the standard
format is provisional/pending customer confirmation.

**Acceptance Scenarios**:

1. **Given** the import screen, **When** it is displayed, **Then** a visible "provisional standard format"
   notice is present (in pt-BR).
2. **Given** the provisional notice, **When** a reviewer reads it, **Then** it communicates that the format
   is a default pending customer sign-off and may change.

---

### User Story 3 - See a clear reason when a file does not match the standard format (Priority: P3)

When an uploaded file does not match the standard format (wrong/missing columns, unparseable dates), the
operator sees **per-row reasons** in the validation preview and can download the existing error report —
instead of an unexplained "failed" import.

**Why this priority**: Converts the previously invisible failure mode into the visible, row-level
feedback slice 004 already provides for other errors. Important for usability, but secondary to removing
the template step.

**Independent Test**: Upload a file whose columns/date formats do not match the standard format and
confirm every affected row shows a reason in the preview and appears in the downloadable error report,
with no batch ending as an unexplained "failed".

**Acceptance Scenarios**:

1. **Given** a file whose columns do not match the standard format, **When** it is imported, **Then** every
   affected data row is surfaced with the existing field-level reasons in the preview (e.g. missing external
   id, unknown location) — not a silent batch failure, and not a separate header-level "wrong format" message.
2. **Given** rows with errors, **When** the operator opens the error report, **Then** the failed rows and
   their reasons are downloadable, consistent with slice 004.
3. **Given** an empty or header-only file, **When** it is imported, **Then** an empty preview (zero data
   rows) is shown, consistent with slice 004 (no per-row reasons, since there are no data rows).

---

### Edge Cases

- **File with entirely different columns** (none match the standard format): every data row surfaces the
  existing field-level reasons (missing external id, unknown location); there is **no** header-level "wrong
  format" message, and the batch does not end as an unexplained "failed".
- **Unsupported file type** (e.g. `.pdf`): rejected at upload with a clear message, as in slice 004 (no
  change).
- **Dates not in the standard format**: surfaced as per-row mapping reasons in the preview, not a silent
  batch failure.
- **A customer that still has a leftover per-customer template row** in the system: ignored by the
  operator flow; the standard format is always applied, so behavior does not diverge by customer.
- **Same standard headers in CSV vs XLSX**: both import successfully using the same format.
- **Empty file / header-only file**: produces an empty preview (zero data rows), consistent with slice
  004 handling.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The import upload flow MUST NOT require or present an import-template selection. The operator
  provides only a **customer** and a **file**.
- **FR-002**: The system MUST apply a single, built-in **standard import format** to every uploaded file,
  identically for all customers. The format is a single in-code definition; **no per-batch template
  reference is stored** (`import_batches.template_id` stays null) and the `import_templates` table is not
  read on the import path.
- **FR-003**: The standard format MUST define the mapping from source columns to internal trip fields
  (external trip id, origin, destination, pickup window, delivery window, vehicle type, status label) and
  the parsing rules (date format, timezone, decimal and thousand separators), using the documented default
  layout (see Key Entities / Assumptions). **Required-field enforcement is exactly slice 004's existing
  behavior** (external trip id present; origin and destination resolvable); the format introduces **no new
  required-column rule** (`requiredOverrides` is empty).
- **FR-004**: The system MUST accept both `.csv` and `.xlsx` uploads under the same standard format, and
  MUST determine which to parse from the **uploaded file's name extension**, not from any stored template
  attribute.
- **FR-005**: An import MUST NEVER fail solely because no template was selected. That failure mode is
  eliminated.
- **FR-006**: Column/format mismatches MUST be surfaced as visible, per-row validation reasons in the
  preview — the existing field-level reasons (e.g. missing external id, unknown location); there is **no
  separate header-level "wrong format" message** — and remain available via the existing error report,
  never as an unexplained batch failure.
- **FR-007**: The upload screen MUST display, as an **always-visible banner at the top of the screen**, a
  clearly visible pt-BR notice that the standard format is **provisional** — a documented default pending
  customer sign-off (PRD §29 #2–#5).
- **FR-008**: All existing post-mapping import behavior MUST be preserved unchanged: validation, duplicate
  detection, confirmation, the error report, history, and status handling (trips continue to land in
  `received`).
- **FR-009**: The feature MUST reuse the existing import permission. No new permission is introduced and
  the set of users who can import is unchanged.
- **FR-010**: Maintainers MUST be able to replace the provisional standard format with real customer
  headers/rules in a **single, localized change** — editing the one in-code standard-format object (column
  mappings + parsing rules + required fields together) — with no schema change, data migration, or backfill.
- **FR-011**: Existing template-management capabilities MUST remain available and functional for possible
  future use, but MUST NOT appear in, or be required by, the operator's normal import flow.
- **FR-012**: The system MUST remove the now-unused template-selection control and its orphaned UI strings —
  including **rewriting the upload subtitle** that currently names "o modelo de importação" — so the screen
  presents no template affordance (FR-001) and leaves no dead i18n keys.

### Key Entities *(include if feature involves data)*

- **Standard Import Format** (the predefined template): a customer-agnostic definition — held as **one
  in-code object** — of the expected source column headers, their mapping to the internal trip fields slice
  004 recognizes, and the parsing rules (date format `dd/MM/yyyy HH:mm`, timezone `America/Sao_Paulo`,
  decimal `,`, thousand `.`). Required-ness is the existing always-on validation (external id present;
  origin/destination resolvable), **not** per-column enforcement. It is a documented default, not a
  signed-off format, and is the only format applied to imports in this slice.
- **Import Batch**: unchanged from slice 004; now always processed against the Standard Import Format
  rather than a per-customer selection.
- **Mapped Trip Fields**: the closed set of internal target fields the import produces — external trip id,
  origin code, destination code, planned pickup/delivery windows, planned vehicle type, status label.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can start an import by providing **only** a customer and a file — zero
  template/configuration steps.
- **SC-002**: 100% of uploads that would previously have failed solely due to "no template selected" now
  proceed to a validation preview.
- **SC-003**: A correctly formatted file imports successfully (rows mapped, validated, confirmable) for
  **any** customer, in **both** CSV and XLSX.
- **SC-004**: When a file does not match the standard format, the operator sees an explicit per-row
  field-level reason for every failed data row (and can download the error report); no import ends as an
  unexplained "failed" with no reason. (No header-level "wrong format" message is expected.)
- **SC-005**: Every operator sees the provisional-format notice on the import screen.
- **SC-006**: No regression: for a correctly formatted file, validation, duplicate-detection, and
  confirmation outcomes are identical to slice 004.
- **SC-007**: Replacing the provisional standard format with real customer headers/rules is a single,
  localized change requiring no migration or data backfill.

## Assumptions

- All customers' import files conform to **one shared column layout** (operator-confirmed decision); this
  slice deliberately does not support per-customer formats.
- The provisional standard format reuses the existing **documented demo mapping** (`id_viagem`, `origem`,
  `destino`, `janela_coleta_inicio/fim`, `janela_entrega_inicio/fim`, `tipo_veiculo`, `status`) and Brazil
  parsing defaults (`dd/MM/yyyy HH:mm`, `America/Sao_Paulo`, decimal `,`, thousand `.`).
- Real, signed-off customer file formats (PRD §29 #2–#5) are **not yet available**; the standard format is
  a documented default and will be revised on sign-off (hence the provisional notice).
- The slice 004 import pipeline (mapping engine, validation, duplicate detection, confirmation, error
  report, history) is in place and is **reused** without redefinition.
- The existing import-template storage and API remain in the system (dormant) — no data migration or
  removal — so this slice adds nothing durable.
- The standard format is supplied as a **single in-code constant**; the batch carries no template id, and
  the worker re-infers CSV vs XLSX from the **file-name extension** (no `file_type` column is added).
- Unmapped status-label warnings are **expected** for customers without seeded status mappings and do **not**
  fail the import (those rows still confirm into `received` as warnings) — so "imports successfully" means
  "reaches a confirmable preview", not "zero warnings".
- Trips continue to land in `received`; status-mapping behavior is unchanged.

## Out of Scope *(Future)*

- Per-customer import templates / formats, and any auto-detection or guessing among multiple formats.
- Any template-management or format-configuration UI.
- Changes to validation, duplicate detection, confirmation, or status mapping (including any header-level
  "wrong format" detection).
- Removing or altering the import-template storage or its endpoints.
- Surfacing batch failure reasons on the import **history** screen (the history list shape/columns stay
  unchanged) — tracked as a follow-up.

## Dependencies & References

- **Builds on slice 004** (trip import & validation): reuses the import pipeline, validation preview,
  error report, and history; this slice **references** 004 and does not edit its shipped spec.
- **PRD** trip-import requirements (slice 004 IDs) and **§29 #2–#5** (blocked per-customer file/SLA/billing
  rules → provisional posture).
- **Constitution V**: one config-driven import engine; customer variation is data, not branching code.
- **Slice 009 precedent**: provisional-banner posture for §29-blocked sign-off.
- **STACK**: no new runtime dependency, table, enum, migration, or worker job (per the locked decisions).
