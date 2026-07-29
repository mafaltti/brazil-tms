# Feature Specification: Driver CPF Replaces E-mail

**Feature Branch**: `022-driver-cpf-field`

**Created**: 2026-07-28

**Status**: Draft

**Input**: User description: "Substituir o campo E-mail do motorista por CPF — issue #28 [0005]"

**Origin**: GitHub issue [#28](https://github.com/mafaltti/brazil-tms/issues/28) (internal ID 0005, Notion "Brazil TMS Issues"): the driver create/edit form carries an **E-mail** field the operation does not use; the business identifies drivers by **CPF** and wants the field replaced.

**Context (diagnosed 2026-07-28)**: driver e-mail exists only as an optional text field — it is never listed, searched, exported, or used by workers/notifications (grep: `drivers-service.ts`, `driver-form.tsx`, `driver-detail-client.tsx`, shared `driverBase`, DB column; zero other readers). Replacing it is a contained product-surface change. The PRD's conceptual model lists "Email if available." under Driver (§14) — amended by this slice.

## Clarifications

### Session 2026-07-28

- Q: Drop the `email` column (destroys data — the issue screenshot shows real prod records with e-mails) or retire it as dormant? → A: **Dormant** — the column stays in the DB (audit/history preservation, same posture as slice 015's dormant enum values and FR-026's no-hard-delete ethos), but leaves every product surface (schema, DTO, form, i18n). A future cleanup migration may drop it once the business confirms.
- Q: CPF validation strength? → A: **Format check only** — 11 digits after stripping punctuation, mirroring the CNPJ posture (R7: "basic format check only"). Check-digit validation is out of scope (future, if the business asks).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The driver form captures CPF, not e-mail (Priority: P1)

A fleet coordinator creating or editing a driver sees a **CPF** field where E-mail used to be. Punctuated input ("123.456.789-01") is accepted and normalized; a value that is not 11 digits is rejected with a pt-BR message. E-mail no longer appears anywhere in the driver product surface.

**Independent Test**: open Novo motorista → the form shows CPF and no E-mail; submit with "390.533.447-05" → driver persists with `39053344705`; submit with "12345" → validation error.

**Acceptance Scenarios**:

1. **Given** the driver create form, **When** it renders, **Then** a CPF field is present and no E-mail field exists.
2. **Given** a CPF typed with punctuation, **When** the form is submitted, **Then** the stored value is the 11 normalized digits and the edit form shows them back.
3. **Given** a CPF with fewer/more than 11 digits, **When** submitted, **Then** the form blocks with "CPF deve ter 11 dígitos."
4. **Given** a blank CPF, **When** submitted, **Then** the driver saves (CPF is optional, like every non-name driver field).
5. **Given** an existing driver that had an e-mail, **When** its edit form opens, **Then** no e-mail is shown, and saving does not error — the stored e-mail value is simply no longer part of the product surface.

---

### Edge Cases

- **Existing e-mails**: preserved in the dormant DB column, invisible to the product; no backfill (e-mail cannot be derived into CPF).
- **Update semantics**: absent CPF key = unchanged; blank = cleared (the shared `blankable` contract all optional driver fields follow).
- **Audit**: `driver.update` snapshots pick up `cpf` generically (field-list based); no new audit action.
- **AI document reading (021, unmerged)**: the CNH carries the CPF — extraction prefill for the new field is a natural follow-up on that slice, out of scope here.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The driver create/edit form MUST offer a CPF field and MUST NOT offer an E-mail field. *(issue #28)*
- **FR-002**: CPF input MUST accept punctuated or bare input and normalize to 11 digits; any other shape is rejected at the boundary with a pt-BR message. Optional field; blank clears, absent leaves unchanged.
- **FR-003**: The stored CPF MUST round-trip: list/detail DTOs deliver it and the edit form re-displays it.
- **FR-004**: Driver e-mail MUST leave every product surface (validation schema, DTO, service field list, form, i18n catalog) while the DB column and existing values remain, dormant, for history.
- **FR-005**: PRD conceptual model (§14 Driver) amended: "Email if available." → "CPF if available."; RES-002 lists CPF; §30 records the decision. Shipped specs (002) are NOT edited.

### Key Entities

- **Driver**: gains optional `cpf` (11-digit string); `email` becomes dormant (DB-only).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of driver create/edit flows expose CPF and 0% expose E-mail — resolving issue #28.
- **SC-002**: Punctuated CPF entries normalize correctly in 100% of cases (unit-tested at the schema boundary).
- **SC-003**: No existing driver record loses data (dormant column preserved).

## Assumptions

- CPF format check (11 digits) satisfies the business today, as the CNPJ precedent did (R7); check digits are a future hardening.
- CPF is optional and non-unique (mirrors CNPJ posture; the issue does not ask for identity/dedup semantics).
