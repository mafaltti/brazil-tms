# Feature Specification: Larger Resource Registration Dialogs

**Feature Branch**: `024-larger-resource-dialogs`

**Created**: 2026-07-28

**Status**: Draft

**Input**: User description: "Aumentar o tamanho da janela de cadastro de Reboque, Veículo e Motorista para que mais informações caibam na visão — issue #31 [0008]"

**Origin**: GitHub issue [#31](https://github.com/mafaltti/brazil-tms/issues/31) (internal ID 0008, Notion "Brazil TMS Issues"): the create dialogs for drivers, vehicles and trailers use the default narrow width (512px) and feel cramped; the customer's reference screenshot shows a substantially wider registration window with more fields in view.

**Context (diagnosed 2026-07-28)**: all master-data create dialogs render `DialogContent` with the base `max-w-lg` (512px) and `max-h-[85vh]`. The three resource dialogs named by the issue are `drivers-client.tsx`, `vehicles-client.tsx`, `trailers-client.tsx`; `cn()` uses tailwind-merge, so a `max-w-*` utility passed via `className` cleanly overrides the base. The forms inside already lay fields out in responsive `sm:grid-cols-2` pairs, which scale with the container.

## Clarifications

### Session 2026-07-28

- Q: How large? → A: **`max-w-4xl` (896px, ~75% wider) + `max-h-[90vh]`** — matches the reference's "big window" feel while staying a modal; the forms' existing paired grids widen with it and the extra height shows more rows before scrolling.
- Q: Rework the forms into 3-column/tabbed layouts like the reference system? → A: **No** — the issue asks for window size; field grouping was issue 0007's territory (slice 023 pinned the vehicle pairs the customer asked for) and a re-flow here would undo it. The reference's tabbed layout is a future redesign if the business asks.
- Q: The other master-data dialogs (customers, carriers, locations, lanes)? → A: **Unchanged** — the issue names the three resource registries only.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The three resource dialogs are substantially larger (Priority: P1)

A fleet coordinator opening Novo motorista / Novo veículo / Novo reboque gets a window ~75% wider (and slightly taller) than before, with the paired fields spread comfortably and more of the form visible without scrolling.

**Independent Test**: at a desktop viewport, each of the three create dialogs measures ~896px wide (was 512px); create flows still work end-to-end.

**Acceptance Scenarios**:

1. **Given** any of the three resource lists, **When** the create dialog opens, **Then** its width is ~896px on desktop (vs 512px before) and its height cap is 90vh.
2. **Given** a small viewport, **When** the dialog opens, **Then** it remains fluid (full-width) and scrollable — no regression on mobile.
3. **Given** the wider dialog, **When** a resource is created, **Then** the existing create flow is unchanged (no form/field/validation change).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The driver, vehicle and trailer create dialogs MUST render at `max-w-4xl` (896px) with `max-h-[90vh]`, scrollable. *(issue #31)*
- **FR-002**: No form, field, validation, or data change — presentation of the dialog container only.
- **FR-003**: Other master-data dialogs and all detail/edit pages are unchanged.

### Key Entities

None — presentation only.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The three resource create dialogs measure ~896px wide at a 1280px desktop viewport (today: 512px; e2e floor 800px, below the enter-animation frame) — resolving issue #31.
- **SC-002**: All existing resource e2e flows keep passing inside the larger dialogs.

## Assumptions

- Wider + taller satisfies "mais informações na visão" for the current single-page forms; the reference system's tabbed/3-column layout is a separate future redesign.
