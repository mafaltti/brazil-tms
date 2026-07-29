# Feature Specification: Vehicle Registry Fields (ANTT, Renavam, Chassi) + Form Layout

**Feature Branch**: `023-vehicle-registry-fields`

**Created**: 2026-07-28

**Status**: Draft

**Input**: User description: "Adicionar número da ANTT, Renavam e Chassi no cadastro de veículos; otimizar o espaço — diminuir a caixa Capacidade para que Placa, Tipo, Renavam e ANTT fiquem juntos — issue #30 [0007]"

**Origin**: GitHub issue [#30](https://github.com/mafaltti/brazil-tms/issues/30) (internal ID 0007, Notion "Brazil TMS Issues"): the vehicle create/edit form lacks the Brazilian registry identifiers the operation records for every truck — **ANTT (RNTRC)**, **Renavam**, and **Chassi (VIN)** — and the full-width **Capacidade** box wastes the space where those identifiers should sit.

**Context (diagnosed 2026-07-28)**: the vehicle surface (shared `vehicleBase`, `vehicles` table, `vehicles-service`, `vehicle-form`, `vehicle-detail-client`) mirrors the driver surface; adding optional identifier fields is the same contained pattern slice 022 used for the driver CPF. The current form renders Placa|Tipo in a 2-col row, then Capacidade full-width (evidence screenshot).

## Clarifications

### Session 2026-07-28

- Q: Validation strength per field? → A: **Match each format's certainty** (the repo's R7 posture): **Renavam** = digits after stripping punctuation, 9–11 (11 modern, 9 legacy); **Chassi** = normalized uppercase VIN, exactly 17 chars from the standard alphabet (no I/O/Q); **ANTT (RNTRC)** = free text ≤ 20 (format varies by era/category — 8 vs 9 digits, older alphanumeric registrations — so no format claim).
- Q: Extend to trailers (which also carry Renavam/Chassi/ANTT legally)? → A: **Vehicles only** — the issue names the vehicle form; the trailer extension is a natural follow-up once the business asks (kept out to match the issue's scope, unlike 0004 where the user explicitly widened it).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The vehicle form captures ANTT, Renavam and Chassi (Priority: P1)

A fleet coordinator creating or editing a vehicle records its ANTT (RNTRC) number, Renavam and Chassi alongside the plate. Values round-trip into the edit form, and malformed Renavam/Chassi entries are rejected with pt-BR messages.

**Independent Test**: create a vehicle with Renavam "12345678901", ANTT "12345678", Chassi "9BWZZZ377VT004251" → persists and re-displays; Renavam "1234" or Chassi with "I/O/Q" or wrong length → blocked at the form.

**Acceptance Scenarios**:

1. **Given** the vehicle create form, **When** it renders, **Then** ANTT, Renavam and Chassi fields are present and optional.
2. **Given** a Renavam typed with punctuation ("1234.567.890-1"), **When** submitted, **Then** it is stored as the 11 stripped digits and re-displayed on edit.
3. **Given** a Renavam with fewer than 9 or more than 11 digits, **When** submitted, **Then** the form blocks with "Renavam deve ter de 9 a 11 dígitos."
4. **Given** a chassi typed lowercase or with spaces/hyphens, **When** submitted, **Then** it is normalized (uppercase, separators stripped) and must be 17 valid VIN characters; otherwise the form blocks with "Chassi inválido (17 caracteres, sem I, O ou Q)."
5. **Given** blank ANTT/Renavam/Chassi, **When** submitted, **Then** the vehicle saves (all three optional); on edit, blanking clears and omitting leaves unchanged (the shared `blankable` contract).

---

### User Story 2 - The form groups the registry identifiers (Priority: P2)

The form's top block reads Placa | Tipo, then Renavam | ANTT — the four registry fields together — with Chassi | Capacidade (kg) next: Capacidade shrinks from full-width to a half-width cell, per the issue's space-optimization request.

**Acceptance Scenarios**:

1. **Given** the vehicle form, **When** it renders, **Then** Placa/Tipo/Renavam/ANTT appear as consecutive paired rows and Capacidade shares a row with Chassi (no full-width Capacidade box).

---

### Edge Cases

- **Duplicates**: no uniqueness for the three identifiers (mirrors the CPF/CNPJ posture; the plate stays the only unique key — the issue asks for storage, not identity semantics).
- **Audit**: `vehicle.update` snapshots pick the new fields up generically (field-list based); no new audit action.
- **Trailers**: unchanged (clarification above).
- **CRLV AI reading (021, unmerged)**: the CRLV carries Renavam and Chassi — extraction prefill for the new fields is a follow-up on that slice after both merge; out of scope here.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The vehicle create/edit form MUST offer optional ANTT (RNTRC), Renavam and Chassi fields. *(issue #30)*
- **FR-002**: Renavam MUST accept punctuated or bare input, normalize to digits, and require 9–11 digits; Chassi MUST normalize (uppercase, strip spaces/hyphens) and require exactly 17 standard-VIN characters (no I/O/Q); ANTT is free text ≤ 20. All three: blank clears, absent leaves unchanged.
- **FR-003**: Stored values MUST round-trip: list/detail DTOs deliver them and the edit form re-displays them.
- **FR-004**: The form layout MUST group Placa, Tipo, Renavam and ANTT (paired rows) and place Capacidade beside Chassi at half width — no full-width Capacidade.
- **FR-005**: PRD conceptual model (§14 Vehicle) and RES-004 amended; §30 records the decision. Shipped specs (002) are NOT edited.

### Key Entities

- **Vehicle**: gains optional `anttNumber` (text ≤ 20), `renavam` (9–11 digits), `chassis` (VIN 17).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of vehicle create/edit flows expose the three registry fields — resolving issue #30.
- **SC-002**: Punctuated Renavam and lowercase/spaced chassi entries normalize correctly in 100% of cases (unit-tested at the schema boundary).
- **SC-003**: The Capacidade box no longer spans the full form width; the four registry fields render as adjacent pairs.

## Assumptions

- Format checks match today's business need (the CNPJ/CPF precedent); check-digit validation for Renavam and the VIN check digit are future hardening if asked.
- The vehicles LIST view is unchanged (the issue targets the form; no new columns were requested).
