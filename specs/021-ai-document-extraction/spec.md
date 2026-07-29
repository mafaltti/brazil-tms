# Feature Specification: AI Document Reading for Resource Registration

**Feature Branch**: `021-ai-document-extraction`

**Created**: 2026-07-27

**Status**: Draft

**Input**: User description: "Leitura automatizada de documentos (CNH/CRLV) com IA para pré-preencher cadastros — issue #29 [0006]"

**Origin**: GitHub issue [#29](https://github.com/mafaltti/brazil-tms/issues/29) (internal ID 0006, Notion "Brazil TMS Issues"): automate registrations — insert vehicle/person data automatically by just sending an image of the document.

## Clarifications

### Session 2026-07-27

- Q: AI provider? → A: **Anthropic Claude API** (vision + schema-validated extraction), server-side only, paid per use (~cents/document); the org supplies `ANTHROPIC_API_KEY`.
- Q: Which documents/registrations? → A: **CNH → driver form** (name, CNH validity) and **CRLV → vehicle/trailer forms** (plate, vehicle type, document validity).
- Q: What does the AI do with the extracted data? → A: **Prefill for human review** — the form is filled and highlighted for the registrar to verify/correct before saving; the AI NEVER creates records on its own.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Register a driver from a CNH photo (Priority: P1)

A fleet coordinator opens "Novo motorista", clicks "Ler documento (IA)", and selects a photo (or PDF) of the driver's CNH. Seconds later the form's name and CNH-validity fields are filled from the document, visibly marked as AI-read; the coordinator reviews, corrects anything misread, completes the remaining fields, and saves normally.

**Why this priority**: driver registration is the issue's emergency pain (ties to issues 0003/0004); the CNH carries exactly the fields the form needs.

**Independent Test**: with a provider key configured, upload a CNH image on the driver form → the mapped fields prefill and the review notice appears; saving still goes through the normal validated create.

**Acceptance Scenarios**:

1. **Given** the driver form and a legible CNH image, **When** the user runs the AI read, **Then** name and CNH validity prefill from the document, a "confira os campos" review notice appears, and nothing is saved until the user submits.
2. **Given** a document where a field is unreadable, **When** extraction returns, **Then** unreadable fields stay empty (never invented) and the notice says which fields could not be read.
3. **Given** a file that is not a legible document (or not a CNH), **When** extraction returns nothing usable, **Then** the user sees a clear "não foi possível ler" message and the form is untouched.
4. **Given** the provider key is not configured, **When** the user tries the AI read, **Then** a clear "recurso não configurado" message appears (the form keeps working manually).

---

### User Story 2 - Register a vehicle or trailer from a CRLV (Priority: P2)

The same flow on the vehicle and trailer forms: a CRLV image prefills plate, vehicle type (when it maps to the catalog), and document validity, for review before saving.

**Acceptance Scenarios**:

1. **Given** the vehicle form and a legible CRLV, **When** the AI read runs, **Then** plate/type/validity prefill for review, same rules as US1.
2. **Given** a CRLV whose vehicle type doesn't map to the catalog, **When** extraction returns, **Then** the type field stays empty for manual choice (no wrong guesses).

---

### Edge Cases

- **Privacy**: the document image is EPHEMERAL — sent from the browser to the BFF and on to the provider, never written to disk, Storage, or the database (the repo/system is public-facing; CNH images are sensitive personal data). Only the extracted field VALUES enter the form, and only if the user saves.
- **Human review is mandatory**: no code path may create/update a record directly from extraction output (clarification: prefill-only).
- **Provider outage/error**: a failed extraction shows a friendly retry message; the form remains fully usable manually.
- **File limits**: images (JPEG/PNG/WebP/GIF) and PDF accepted; limits are media-type-aware — images > 7,5 MB raw (Anthropic caps images at 10 MB after base64 encoding) and PDFs > 10 MB raw are refused client-side with a clear message, and the server independently rejects oversized payloads (400) without calling the provider.
- **Dates**: extracted dates land in the form as calendar dates (São Paulo semantics, `YYYY-MM-DD`), matching the existing expiry fields.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The driver form MUST offer an AI document read that accepts a CNH image/PDF and prefills the form's matching fields (name, CNH validity). *(issue #29)*
- **FR-002**: The vehicle and trailer forms MUST offer the same read for CRLV, prefixing plate, vehicle type (only when it maps to the existing catalog), and document validity.
- **FR-003**: Extraction output MUST be schema-validated; unreadable/uncertain fields MUST come back empty rather than guessed, and the user MUST be told which fields were not read.
- **FR-004**: Extracted data MUST only PREFILL the form for human review — submission continues through the existing validated create/update paths; no auto-registration. *(clarification 2026-07-27)*
- **FR-005**: The document image MUST NOT be persisted anywhere in the system (no Storage, no DB, no logs with payloads); it flows browser → BFF → provider and is discarded.
- **FR-006**: The extraction endpoint MUST be BFF-only, authenticated, and gated by the fleet-registration permission (`manage_fleet_data`); the provider key MUST be server-only configuration.
- **FR-007**: When the provider key is absent, the feature MUST degrade gracefully ("não configurado"); provider errors MUST NOT break the manual form flow.
- **FR-008**: All UI text in pt-BR via the existing catalog.

### Key Entities

None — no data model change; extraction output is transient form state.

## Success Criteria *(mandatory)*

- **SC-001**: Registering a driver from a legible CNH takes ≤ 30 s from image selection to reviewed prefill (vs full manual typing) — resolving issue #29's automation ask.
- **SC-002**: Zero records created without human review; zero document images persisted.
- **SC-003**: With no key configured, the registration flows behave exactly as today (feature dark, no errors).

## Assumptions

- Cost is per-use (~cents/document with the selected provider/model); volume is low (fleet registrations), so no budget controls beyond the permission gate are needed in this slice.
- Extraction quality on poor photos varies; the review step is the safety net (issue 0007's new vehicle fields — ANTT/Renavam/Chassi — are NOT in the schema yet; when that slice lands, the CRLV extraction can be extended).
- e2e in CI/local machine runs WITHOUT a provider key — automated coverage exercises the UI affordance + not-configured/error paths and the pure mapping logic; live extraction is verified manually with a real key (documented in quickstart).
