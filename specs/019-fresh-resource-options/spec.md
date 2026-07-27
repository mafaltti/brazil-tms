# Feature Specification: Fresh Resource Options (New Driver Appears Without Reload)

**Feature Branch**: `019-fresh-resource-options`

**Created**: 2026-07-27

**Status**: Draft

**Input**: User description: "Motorista recém-cadastrado aparece nos pickers sem recarregar a página — issue #26 [0003]"

**Origin**: GitHub issue [#26](https://github.com/mafaltti/brazil-tms/issues/26) (internal ID 0003, Notion "Brazil TMS Issues"): after registering a driver, it takes **10–15 minutes** for them to "appear in the system" — crippling in emergencies (register a substitute driver, assign immediately).

**Root cause (diagnosed 2026-07-27)**: the resource/filter option lists (drivers, vehicles, trailers, carriers, plus customers/locations/lanes) are loaded **once, server-side, at page render** and passed down as props. The boards poll trip DATA every 30–60 s, but the option lists are never refetched — so on a tab that stays open (the dispatcher's normal mode), a newly registered driver never enters the assignment pickers until someone fully reloads the page. The "10–15 minutes" is the human retry/reload latency, not a backend delay: the driver row is in the database instantly.

**Fix shape**: make the option lists a **polled, focus-refreshed client query** (the constitution's freshness mechanism — polling, never Realtime), seeded by the already-loaded server data so nothing flashes or slows down.

## Clarifications

### Session 2026-07-27

- Q: Which surfaces adopt the fresh (polled) option lists — only the three assignment surfaces, or every page that loads these lists? → A: **All nine option-loaded pages** (Torre, Trip Detail, Expedição, Exceções, Relatórios, Regras de SLA, Faturamento, Tarifas, Requisitos de Documentos) via one shared hook — eliminates the whole staleness class.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A just-registered driver is assignable within a minute, no reload (Priority: P1)

A fleet coordinator registers a new driver during an emergency. The dispatcher — whose Expedição/Trip Detail tab has been open all along — opens the Motorista picker moments later and the new driver is there (at most one refresh cycle away, faster when the dispatcher switches back to the tab, which refreshes immediately on focus).

**Why this priority**: the issue's exact emergency scenario.

**Independent Test**: with the dispatch screen open, insert a new active driver; without any reload, the driver appears in the assignment picker within the refresh interval (and immediately after a tab-focus switch).

**Acceptance Scenarios**:

1. **Given** an open assignment surface (Trip Detail panel, Dispatch dialog, or quick-assign dialog), **When** a new driver/vehicle/trailer/carrier is registered elsewhere, **Then** the picker lists include it within one refresh interval, with no page reload.
2. **Given** the user switches away and back to the tab, **When** the tab regains focus, **Then** the lists refresh immediately (focus refetch), so the register-then-assign flow is near-instant.
3. **Given** a resource is archived, **When** the lists refresh, **Then** it leaves the pickers on the same cycle (same freshness, both directions).
4. **Given** the server-rendered page load, **When** the surface first paints, **Then** the lists are present immediately (server data seeds the query — no empty flash, no extra initial latency).

---

### User Story 2 - Board filters stay fresh the same way (Priority: P2)

The Control Tower's resource filters (and, per the pending clarification, the other option-loaded dropdowns) refresh on the same cycle, so filtering by a new driver/vehicle doesn't require a reload either.

**Acceptance Scenarios**:

1. **Given** the Control Tower open, **When** a new driver is registered, **Then** the assigned-driver filter offers them within one refresh interval.

---

### Edge Cases

- **Open dialog while lists refresh**: a refresh must not clear or reorder the user's in-progress selection (selected IDs are stable; the list under an open combobox may gain rows on the next open).
- **Failed refresh**: keep showing the last-known lists (stale-but-usable beats empty); next cycle retries.
- **Permissions unchanged**: the lists come from the same read model under the same authenticated boundary — the endpoint requires the same `view_all_trips` every consuming page already requires.
- **No extra load**: the lists are bounded config/master data; one lightweight request per interval per open tab.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The resource/filter option lists MUST be refreshed periodically on open pages (polling — the constitution's freshness mechanism; NO Realtime) and immediately on window refocus.
- **FR-002**: A newly registered (or archived) resource MUST be reflected in the in-scope pickers/filters within one refresh interval — target ≤ 60 s — with zero page reloads. *(issue #26)*
- **FR-003**: The first paint MUST keep today's behavior: server-loaded lists shown immediately (the client query is seeded with them; no loading flash, no added initial latency).
- **FR-004**: A list refresh MUST NOT disturb in-progress user state: current selections (IDs) persist; an open picker's interaction is not reset.
- **FR-005**: The lists MUST be served by the BFF under the existing authenticated boundary (`view_all_trips` — held by all internal roles that reach these pages); no new permission key.
- **FR-006**: On refresh failure the previous lists MUST remain usable; refresh retries on the next cycle.
- **FR-007**: ALL nine option-loaded pages adopt the fresh lists via the same shared mechanism (clarification 2026-07-27): Torre de Controle (filters + quick-assign), Trip Detail (assignment panel), Expedição, Exceções, Relatórios, Regras de SLA, Faturamento, Tarifas, Requisitos de Documentos.

### Key Entities

None — no data model change; the existing options read model is exposed through a BFF read endpoint.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Register-to-assignable latency for a new driver drops from ~10–15 min (human reload latency) to **≤ 60 s** on an untouched open tab, and to **seconds** when the user switches back to the tab — resolving issue #26.
- **SC-002**: Zero regressions in first-paint behavior (lists visible immediately on load, as today).
- **SC-003**: The assignment write path and eligibility checks are untouched (values/IDs unchanged).

## Assumptions

- The option lists are bounded (master data) — polling them is cheap; interval aligned with the existing board polling family (30–60 s).
- The master-data registration screens themselves already reflect writes immediately (mutation invalidation) — this slice is about the OTHER open surfaces.
- No push/Realtime mechanism is introduced (constitution).
