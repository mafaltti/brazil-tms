# Feature Specification: Searchable Resource Pickers (Type/Paste to Select)

**Feature Branch**: `018-searchable-resource-pickers`

**Created**: 2026-07-27

**Status**: Draft

**Input**: User description: "Filtragem por nome do motorista e placa com busca por digitação/colagem nos pickers de atribuição — issue #25 [0002]"

**Origin**: GitHub issue [#25](https://github.com/mafaltti/brazil-tms/issues/25) (internal ID 0002, Notion "Brazil TMS Issues"): in the resource-assignment form, the assigner cannot type the full driver name — only first-letter jumps — so similar names (and near-identical plates differing by one character) are hard and error-prone to pick. The request: allow typing AND **pasting** the full driver name / vehicle plate, with the picker filtering and selecting automatically.

**Context**: The shared assignment form (006, one write path for its three entry points — Trip Detail panel, Dispatch board dialog, Control Tower quick-assign dialog) renders four plain dropdown pickers (`ResourceSelect`: motorista by name, veículo by plate, reboque by plate, transportadora by name) with no text input. The Control Tower board filters (assigned driver/vehicle/carrier) use the same plain dropdowns. Option lists are already server-loaded and bounded (active fleet). This slice changes ONLY how options are found and picked — no data model, permission, or write-path change.

## Clarifications

### Session 2026-07-27

- Q: Does the searchable behavior cover only the four assignment-form pickers, or also the Control Tower board filter dropdowns? → A: **Assignment form + the three resource board filters** (assigned driver/vehicle/carrier), one shared component; customer/origin/destination/lane filters stay as-is.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Pick a driver by typing or pasting the full name (Priority: P1)

An assigner working the assignment form clicks the Motorista picker and types — or pastes from the customer's message — the driver's full name. The list narrows as they type, ignoring case and accents; when the pasted/typed text matches exactly one driver, that driver is selected automatically.

**Why this priority**: This is the issue's core complaint — full-name entry is impossible today and similar names cause wrong picks.

**Independent Test**: With drivers "João da Silva Santos" and "João da Silva Souza" in the list, paste "joao da silva souza" → the picker selects João da Silva Souza automatically; typing "joão" alone shows both.

**Acceptance Scenarios**:

1. **Given** the Motorista picker, **When** the user types part of a name, **Then** the list shows only drivers whose names contain the typed text, matching case- and accent-insensitively.
2. **Given** the picker with text pasted that matches exactly one driver (ignoring case, accents, and surrounding whitespace), **When** the paste lands, **Then** that driver becomes the selected value without further clicks.
3. **Given** typed text matching multiple drivers, **When** the user picks one from the narrowed list (mouse or keyboard ↑/↓ + Enter), **Then** that driver is selected.
4. **Given** typed text matching no driver, **When** the list is empty, **Then** a "nenhum resultado" state is shown and no value is selected.
5. **Given** an already-selected driver, **When** the user reopens the picker, **Then** they can clear/replace the search text and the full list is available again.

---

### User Story 2 - Pick a vehicle or trailer by typing or pasting the plate (Priority: P1)

The same behavior on the Veículo and Reboque pickers, matching by plate — where near-identical plates (one character apart) are the pain. Plate matching additionally ignores separators (hyphen/space), so "ABC-1234", "abc 1234" and "ABC1234" all find the same plate.

**Independent Test**: With plates "RTA1B23" and "RTA1B24", paste "rta1b24" → auto-selects the second; typing "RTA1B" shows both.

**Acceptance Scenarios**:

1. **Given** the Veículo picker, **When** the user types/pastes a plate in any casing, with or without hyphen/space, **Then** matching is normalized (case + separators) and behaves as US1.
2. **Given** the Reboque picker (clearable), **When** the user searches, **Then** the same behavior applies AND the "Sem reboque" clear option remains available.

---

### User Story 3 - Same capability on the carrier picker and the board resource filters (Priority: P2)

Transportadora (by name, clearable) gets the same searchable behavior. Subject to the pending clarification, the Control Tower board's assigned-driver / assigned-vehicle / assigned-carrier filter dropdowns adopt the same component, so the same paste-to-find works when filtering the board.

**Acceptance Scenarios**:

1. **Given** the Transportadora picker, **When** the user types/pastes a carrier name, **Then** US1 behavior applies and the "Sem transportadora" clear option remains available.
2. **Given** the board's assigned-driver filter (if in scope), **When** the user pastes a full driver name, **Then** the filter selects that driver and the board narrows accordingly.

---

### Edge Cases

- **Paste with decoration**: leading/trailing whitespace and internal repeated spaces in the pasted text must not break the exact match (normalize before comparing).
- **Two options with identical labels**: exact text matches multiple options → do NOT auto-select; show both for a manual pick (auto-select requires uniqueness).
- **Empty search on open**: opening the picker without typing shows the full list (current browse behavior preserved).
- **Selection integrity**: the form value remains the resource ID; a typed string that was never resolved to an option is not a value (submit still requires real driver/vehicle IDs — no free text leaks into the write path).
- **Live findings unchanged**: picking via search triggers the same debounced eligibility check as picking via the old dropdown (no behavior change in the write path or conflict checks).
- **Keyboard parity**: full keyboard flow (type → ↑/↓ → Enter; Esc closes) and screen-reader labels preserved per field.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The four assignment-form pickers (motorista, veículo, reboque, transportadora) MUST accept free text input that filters their option lists as the user types. *(issue #25)*
- **FR-002**: Matching MUST be case-insensitive and accent-insensitive on names; for plates it MUST additionally ignore hyphens and spaces.
- **FR-003**: When the entered text — after normalization and whitespace trimming — matches exactly ONE option's full label, that option MUST be selected automatically (the paste-to-select flow); when it matches several or none, no auto-selection occurs.
- **FR-004**: An empty-result state ("nenhum resultado") MUST be shown when the text matches no option; clearing the text MUST restore the full list.
- **FR-005**: Mouse and keyboard selection (↑/↓, Enter, Esc) MUST be supported, with accessible labels per field (the current Label/id wiring).
- **FR-006**: The clearable pickers (reboque, transportadora) MUST keep their explicit clear option ("Sem reboque"/"Sem transportadora") reachable regardless of search text.
- **FR-007**: The submitted form values MUST remain resource IDs resolved from picked options — free text never reaches the write path, and the assignment/reassignment/eligibility behavior is unchanged.
- **FR-008**: The searchable pickers MUST behave identically in all three form entry points (Trip Detail panel, Dispatch board dialog, Control Tower quick-assign dialog) — one shared component, not per-surface variants.
- **FR-009**: The Control Tower board's assigned-driver / assigned-vehicle / assigned-carrier filter dropdowns MUST adopt the same searchable component (customer/origin/destination/lane filters unchanged). *(clarification 2026-07-27)*
- **FR-010**: All new UI text MUST ship in pt-BR via the existing i18n catalog.

### Key Entities

None — no data model change; option lists are the already-served `resourceOptions` (driver name / vehicle plate / trailer plate / carrier name).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Pasting a full driver name or plate selects the right resource in ≤ 1 further action (zero when unique), versus today's scroll-and-guess — resolving issue #25.
- **SC-002**: Typing narrows any picker's list with case/accent (and plate-separator) insensitivity; two options that differ by one character are distinguishable by typing that character.
- **SC-003**: Zero regressions in the assignment write path: the existing assignment/reassign/confirm/unassign e2e flows pass unchanged apart from the new picker interaction.
- **SC-004**: The full flow is operable by keyboard only.

## Assumptions

- Option lists remain bounded (active fleet, single-digit hundreds at most) and fully server-loaded — client-side filtering is adequate; no server search endpoint is added (KISS).
- The picker remains a pick-from-list control; free-text creation of resources is out of scope.
- Master-data screens (Motoristas/Veículos/Reboques pages) and other app dropdowns are out of scope unless the clarification says otherwise.
- No permission, audit, status-machine, or BFF change — this is presentation-layer only.
