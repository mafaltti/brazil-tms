# Feature Specification: Documents Tab for Drivers and Vehicles

**Feature Branch**: `025-resource-documents`

**Created**: 2026-07-28

**Status**: Draft

**Input**: User description: "Criar aba de inserção de documentos de veículos e pessoas (anexos como CNH digital, photocheck etc.), com histórico dos documentos enviados — issue #32 [0009]"

**Origin**: GitHub issue [#32](https://github.com/mafaltti/brazil-tms/issues/32) (internal ID 0009, Notion "Brazil TMS Issues"): the driver and vehicle registries have nowhere to attach the actual files (CNH digital, photocheck, CRLV…); the reference system shows a **"Documentos" tab** inside the registration window with a chronological list of every file ever sent (type + timestamp) and an upload control with a document-type field.

**Context (diagnosed 2026-07-28)**: feature 008 built the storage plumbing for TRIP proof documents — private `documents` bucket, PDF/JPG/PNG allow-list, `DOCUMENT_MAX_BYTES` cap, upload-then-insert with binary rollback, server-mediated signed URLs — but its `documents` table is trip-scoped with verification/billing semantics that do not apply to registry attachments. Resource documents are a separate, leaner concern: an append-only upload history per driver/vehicle.

## Clarifications

### Session 2026-07-28

- Q: Generalize the shipped 008 `documents` table or a new table? → A: **New `resource_documents` table** — 008's rows carry trip FKs, verification workflow and billing gating; forcing registry attachments into it would pollute a shipped domain. The new table is append-only metadata (the binary stays in Storage, 008 posture).
- Q: Document types — config table like 008's `document_types`? → A: **Free text (≤ 60 chars) with per-entity UI suggestions** (driver: CNH digital, Photocheck, Comprovante de endereço…; vehicle: CRLV digital, ANTT, Seguro, Foto). Zero new config surface (KISS); promote to a config master later if the business asks.
- Q: Delete/replace? → A: **Append-only** — "histórico dos documentos enviados" is the ask; sending a newer CNH digital adds an entry (the reference shows years of history). No delete/archive in V1.
- Q: Which entities? → A: **Drivers ("pessoas") + vehicles**, per the issue text. Trailers are a natural follow-up (the schema's entity discriminator is a CHECK, extendable without enum surgery).
- Q: Permission? → A: **`manage_fleet_data`** for upload, list and download — registry attachments are fleet-data management, and the pages hosting the tab are already gated on it. No new permission key.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Upload and history on the driver/vehicle edit window (Priority: P1)

A fleet coordinator opens a driver (or vehicle) for editing and switches to the **Documentos** tab: a chronological list ("Documentos anexados") shows every file sent — date/time (São Paulo), document type, file name — newest first. They pick a type (suggestions offered), choose a PDF/JPG/PNG up to ~10 MB, and send; the new entry appears at the top. Clicking an entry opens the file via a short-lived link.

**Independent Test**: on a driver's edit page, upload a "CNH digital" PDF → it tops the list with type + timestamp; upload a second one later → both remain listed; click one → the file opens; a .exe or oversized file is refused with a clear message and nothing is stored.

**Acceptance Scenarios**:

1. **Given** a driver/vehicle edit page, **When** it renders, **Then** a "Documentos" tab exists beside the registration data tab (create mode has no tab — the record must exist first).
2. **Given** a valid file + type, **When** sent, **Then** the entry appears in the history with type, file name and pt-BR São Paulo timestamp, newest first, and an audit entry records the upload.
3. **Given** a disallowed file type or an oversized file, **When** sent, **Then** the upload is refused with a clear pt-BR message and nothing is stored (008's R9 posture).
4. **Given** an existing entry, **When** clicked, **Then** the binary opens via a short-lived signed URL — never a public object path.
5. **Given** a user without `manage_fleet_data`, **When** they call the endpoints, **Then** 403 (the hosting pages already redirect them).
6. **Given** repeated uploads of the same type, **Then** ALL entries remain — append-only history, no replacement.

---

### Edge Cases

- **Archived resources**: history stays viewable; new uploads are refused (409) — an archived registry should not grow.
- **Missing resource**: upload/list against an unknown id → 404; nothing stored.
- **Storage/DB race**: metadata insert failure rolls back the stored binary (008 pattern); a storage failure stores nothing.
- **Local dev**: the no-Docker harness lacks Storage — the mock server gains minimal Storage endpoints so the flow is e2e-testable locally; the real stack is exercised via the quickstart.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Driver and vehicle EDIT pages MUST offer a "Documentos" tab with the upload control and the append-only history (type, file name, timestamp, newest first). *(issue #32)*
- **FR-002**: Uploads MUST validate type (PDF/JPG/PNG) and size (`DOCUMENT_MAX_BYTES`, ~10 MB) BEFORE storing; refusals are clear pt-BR messages and store nothing.
- **FR-003**: The binary lives ONLY in Storage (private `documents` bucket, `resources/…` key prefix); Postgres keeps metadata only; downloads are short-lived signed URLs.
- **FR-004**: Upload, list and download are gated on `manage_fleet_data`; every upload writes an audit entry in the same transaction as the metadata insert.
- **FR-005**: History is append-only: no update/delete surface; uploads to archived or missing resources are refused.
- **FR-006**: PRD amended (§14 Driver/Vehicle attachments, §30 decision); shipped specs (002/008) NOT edited.

### Key Entities

- **ResourceDocument**: entity discriminator (driver|vehicle, CHECK — extendable), entity id, document type (free text ≤ 60), file name, content type, size, storage key, uploader, created-at. Append-only.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of driver/vehicle edit pages expose the Documentos tab with working upload + history — resolving issue #32.
- **SC-002**: 0 registry binaries in Postgres; 0 public object URLs (signed-URL downloads only).
- **SC-003**: Disallowed/oversized uploads are refused with nothing stored, in 100% of cases.

## Assumptions

- The 008 file posture (PDF/JPG/PNG ≤ ~10 MB) fits registry attachments; new formats are config/future.
- Free-text types satisfy today's need; a configurable type master is future hardening.
- Trailers, verification workflows, and expiry-date linkage (e.g. auto-reading the CNH validity from the attachment — 021's reader) are out of scope.
