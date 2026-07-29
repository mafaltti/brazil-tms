# Feature Specification: License/Document Expiry Visibility in Resource Lists

**Feature Branch**: `020-license-expiry-visibility`

**Created**: 2026-07-27

**Status**: Draft

**Input**: User description: "Exibir a validade da CNH (e vencimentos de documentos) na listagem com aviso de vencimento — issue #27 [0004]"

**Origin**: GitHub issue [#27](https://github.com/mafaltti/brazil-tms/issues/27) (internal ID 0004, Notion "Brazil TMS Issues"): the registered CNH validity never appears in the driver list — the "Validade da CNH" column shows "—" — and the user wants the date visible, a warning when it is close to expiring, and red highlighting once expired.

**Root cause (diagnosed 2026-07-27)**: the column renders only the DERIVED state, never the date: `ok` → "—" (indistinguishable from "no date registered"), `expiring`/`expired` → a badge alone. The date IS captured by the form, stored, and already delivered to the client (`DriverDto.licenseExpiry`); the derived state (`documentExpiryState`, 30-day warning window, São Paulo calendar) already exists and drives assignment-eligibility warnings. Vehicles and trailers have the identical pattern on `documentExpiry`.

## Clarifications

### Session 2026-07-27

- Q: Apply the fix to drivers only (the issue's screen) or to all three resource lists sharing the pattern? → A: **Drivers + vehicles + trailers** — same cell treatment on all three (same derived state, same cost).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The CNH validity is visible, with warning and expired states (Priority: P1)

A fleet coordinator scanning the Motoristas list sees each driver's CNH validity date. Dates within the warning window carry an "A vencer" warning; expired dates are highlighted in red ("Vencido"); a driver with no registered date reads "Não informada" — no longer conflated with a healthy license.

**Independent Test**: seed drivers with (a) no date, (b) a far-future date, (c) a date inside the 30-day window, (d) a past date; the list shows respectively "Não informada", the plain date, date + "A vencer" warning, and date + red "Vencido".

**Acceptance Scenarios**:

1. **Given** a driver with a registered CNH validity outside the warning window, **When** the list renders, **Then** the formatted date is visible (no badge needed).
2. **Given** a driver whose CNH expires within the warning window (30 days, São Paulo calendar — the existing derived state), **When** the list renders, **Then** the date appears WITH the "A vencer" warning.
3. **Given** a driver whose CNH is expired, **When** the list renders, **Then** the date appears highlighted in red with the "Vencido" state.
4. **Given** a driver with no registered date, **When** the list renders, **Then** the cell reads "Não informada" (distinct from a healthy date).

---

### User Story 2 - Vehicles and trailers get the same treatment (Priority: P2)

The Veículos and Reboques lists render their document validity (`documentExpiry`) with the identical cell: date always visible, warning and expired states, "Não informada" when absent.

**Acceptance Scenarios**:

1. **Given** the vehicle list, **When** it renders, **Then** each row's document validity follows the same four-state presentation as US1.

---

### Edge Cases

- **Expiring today**: the existing derived state counts "today" as expired (days ≤ 0) — the cell follows it (red), no re-derivation in the UI.
- **Timezone**: date-only values display as stored (calendar dates), no timezone shifting.
- **Detail/edit unchanged**: the driver detail page and forms already expose the date; only the LIST cells change.
- **Eligibility engine untouched**: assignment warnings already use the same derived state — no behavior change there.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Motoristas list MUST display each driver's registered CNH validity date. *(issue #27)*
- **FR-002**: When the validity falls within the existing warning window (30 days), the date MUST carry a visible "A vencer" warning; when past, it MUST be highlighted in red with the "Vencido" state. The derived state is the EXISTING shared computation — the UI must not re-derive it.
- **FR-003**: A missing date MUST read "Não informada", visually distinct from a healthy registered date.
- **FR-004**: The Veículos and Reboques lists MUST apply the identical presentation to their document validity. *(clarification 2026-07-27)*
- **FR-005**: One shared cell treatment serves all three lists (no per-list variants); all text in pt-BR via the existing catalog.
- **FR-006**: No data-model, form, permission, or eligibility change — presentation of already-delivered data only.

### Key Entities

None — `licenseExpiry`/`documentExpiry` and `documentExpiryState` already flow to the client.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of drivers with a registered CNH validity show the date in the list (today: 0%) — resolving issue #27.
- **SC-002**: Expiring/expired resources are identifiable at a glance (warning/red states) across the three lists.
- **SC-003**: "No date registered" is never displayed as a healthy state.

## Assumptions

- The 30-day warning window (existing shared constant) satisfies "próxima do vencimento"; changing the window is out of scope (config/future).
- Proactive notifications (007-style in-app alerts for expiring documents) are out of scope — this slice is list visibility; an alert-engine extension would be its own slice.
- Carriers use contract/doc STATUS fields (not a date) — out of scope.
