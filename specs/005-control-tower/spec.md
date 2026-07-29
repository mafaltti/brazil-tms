# Feature Specification: Control Tower, Trip List, Trip Detail, and Daily Dashboard

**Feature Branch**: `005-control-tower`

**Created**: 2026-05-30

**Status**: Draft

**Input**: User description: "005 — Control Tower, Trip List, Trip Detail, and Daily Dashboard. Operations can see, search, filter, and inspect trips in one operating board. Screens: Home Dashboard, Trip Control Tower, Trip Detail. Users view and filter trips they are permitted to see; filters include customer, date, status, origin, destination, lane, vehicle type, assigned driver, assigned vehicle, carrier, SLA risk, and billing status. Trip detail shows customer plan, assignment, timeline, exceptions, documents, billing details, and audit history. Authorized users can edit operational fields before completion. A daily dashboard helps managers answer what needs attention today. Dense operational tables, not marketing UI; polling via TanStack Query for freshness; documents and billing sections may be placeholders until Feature 008. Do not invent missing customer, SLA, document, or billing details — make behavior configurable and mark final sign-off blocked when inputs are unavailable."

**Source PRD sections**: §11.4, §13.4, §13.12, §15.2, §15.4, §15.5, §16, §22 (Phase 2), §23

**Primary requirement IDs**: TRIP-001, TRIP-002, TRIP-003, TRIP-004, TRIP-005, REP-001, REP-005

**Slice ownership**: `docs/SPEC-SLICING.md` slice 005 — owns the **read/operating surface** over the trip domain: the Trip Control Tower board, the Trip Detail page, and the Home (daily) Dashboard, plus filtered-list export and editing of operational (live planned) fields before completion. It **reuses, never redefines**: the platform/auth/audit/i18n primitives from slice 001, the master data (Customer, Location, Lane, fleet) from slice 002, and the shared trip domain model, status machine, plan-update service, and audit semantics from slice 003 (and the import batches from slice 004). Quick assignment actions are owned by slice 006; quick exception creation, timeline interaction, and SLA risk computation by slice 007; documents and billing readiness/export by slice 008; advanced reports (REP-002/003/004) by slice 009; bulk update is Later.

---

## Overview & Intent *(why this feature exists)*

Slices 003 and 004 give Brazil Transports a durable **trip model** and a way to **get trips in** (import). This slice is where the operation actually **runs the day**: one dense operating board where any authorized internal user can **see, search, filter, and inspect** every trip, open a **complete record** for a single trip, and answer the manager's question — *"what needs attention today?"* — from a single dashboard.

The product is an **operational control system, not a marketing website** (PRD §16): dense-but-readable tables, fast filters, saved/default views, persistent search, keyboard-friendly navigation, and clear status colour with accessible contrast. Freshness comes from **polling via TanStack Query** — never Supabase Realtime (STACK §3.3, §3.10).

This slice is deliberately **read-first**. Its single write capability is **editing operational (live planned) fields before completion** (TRIP-005), and even that is **not a new write path** — it calls slice 003's existing trip plan-update service, inheriting its before-/after-`confirmed` review gate and audit recording. The status machine, billing projection, assignment writes, exception writes, timeline writes, document writes, billing export, and SLA computation are **owned by other slices** and are consumed here read-only or shown as placeholders.

The reason this slice comes now: it consumes everything 001–004 built and is the screen every later slice (006 dispatch, 007 execution/SLA, 008 documents/billing, 009 reporting) plugs into. Where a board element needs data a later slice owns — **assigned driver/vehicle/carrier (006), SLA risk (007), documents and billing detail (008)** — the element exists in the contract now and renders as a clearly-marked placeholder, so no customer, SLA, document, or billing values are invented (Constitution Principle II).

---

## Clarifications

### Session 2026-05-30 *(design decisions resolved while specifying; informed defaults — business-input gaps are recorded under "Blocked / Open for business sign-off")*

- Q: Which roles may view the control tower, trip list, and trip detail? → A: **All 7 MVP internal roles** (Admin, Operations Manager, Dispatcher, Control Tower, Fleet Coordinator, Finance, Executive Viewer) — PRD §18 "View all trips" is *Yes* for all internal roles. Enforced in the BFF via the **existing** `view_all_trips` permission key (already in the 001 catalog and granted to all 7 internal roles) — **first enforced in 005** (no new key, no DB permissions table); 005 re-gates the trip read endpoints from `manage_trips` → `view_all_trips`. Customer Viewer and customer-scoped row filtering are **post-MVP** (Decision §30), so "permitted to see" at MVP means **all trips** for any authenticated internal user.
- Q: TRIP-002 lists filters whose source data is owned by later slices (assigned driver/vehicle/carrier → 006; SLA risk → 007; document/billing detail → 008). What does 005 do? → A: 005 **owns the filter/list/detail/dashboard framework** and activates every dimension whose data already exists in the trip read model at 005's time (customer, date, status, origin, destination, lane, vehicle type, billing status). The Control-Tower **filters and row indicators** for the four later-slice dimensions are **delivered by slices 006/007** (see the refined "no dead controls" decision below); the **Trip Detail** sections and **Home Dashboard** widgets that depend on later-slice data remain 005-built placeholders. No values are invented.
- Q: What are the "operational fields" an authorized user can edit before completion (TRIP-005)? → A: The **live planned fields** of the trip (planned pickup/delivery windows, planned vehicle type, planned volume/weight/pallets, route notes, service requirements) — the exact set slice 003's plan-update service already governs. 005 builds the editing **UI**; it calls 003's service, which preserves the immutable original plan, audits per-field changes, and **requires authorized review for edits after `confirmed`** (003's `REVIEW_REQUIRED` gate).
- Q: When is editing blocked? → A: Once a trip reaches **`completed`** or any later/terminal status (`billing_pending`, `billing_ready`, `billed`, `cancelled`; `disputed` per 003 rules), operational-field editing is disabled — "before completion" per TRIP-005.
- Q: Does 005 perform status transitions or assignment from the board? → A: **No.** Status transitions are owned by the workflow slices (dispatch 006: assigned/confirmed; execution 007: at-origin … unloaded; finance: billing states). 005 shows status **read-only**; "quick status update / quick assignment / quick exception" board affordances arrive with 006/007.
- Q: How is the board kept fresh? → A: **Polling via TanStack Query**, interval tuned per surface (shorter for the active control tower, longer for the overview dashboard and slow-moving views — see the polling-cadence defaults above). Intervals are **configuration with documented defaults** (no Realtime).
- Q: Are "saved views" user-created and persisted in MVP? → A: MVP ships the **predefined default views whose data exists at this slice** (Today, Next 24 hours, In transit, Billing pending) as selectable, deep-linkable presets, via a view framework that lets slices 006/007/008 register the remaining §15.4 views (Unassigned → 006, At risk → 007, Missing documents → 008) when their data lands. Filter state is reflected in the URL so any view is shareable/bookmarkable. **User-defined persisted saved views** are deferred (YAGNI) until a real need appears.
- Q: What does "billing status" mean as a filter at 005? → A: The **derived projection** from slice 003 — non-null only when `current_status ∈ {billing_pending, billing_ready, billed, disputed}`. It is filterable now over those projected values; the **detailed billing section and billing-readiness reasons** are placeholders until slice 008.
- Q: What are the default per-surface polling cadences (configurable)? → A: **Option A** — Control Tower **30s**, Home Dashboard **60s**, Trip Detail **30s**; documented defaults, tunable by Ops per STACK §3.3; no Realtime.
- Q: What format and delivery mechanism for the filtered-list export (REP-005)? → A: **CSV, synchronous download with a row cap (option A).** The BFF streams the filtered, permitted rows directly (a filtered list at medium scale is bounded, not "heavy"); over-cap results prompt the user to narrow filters (no silent truncation). **XLSX and a worker-generated export are deferred** — the heavy worker-export pipeline is owned by slice 008.
- Q: What is the Control Tower default landing state (no view/filter chosen)? → A: **Active/open trips (option B)** — all non-terminal trips (statuses `received`…`unloaded`; excludes `completed`, `billing_pending`, `billing_ready`, `billed`, `cancelled`), ordered by planned pickup, with completed/billed/cancelled history reachable via filters/views. This bounds the default result set at medium scale.
- Q: What trip volume/scale should the board and read models be built for? → A: **Medium (option B)** — ~1k–10k active trips on the board and ~50k–500k retained per year. Design for **server-side pagination + indexed filters** (dense-table row virtualization only if a single page grows large — deferred, YAGNI); no materialized views / partitioning at MVP (revisit only if volume approaches option C: 10k+ active / 1M+ retained).
- Q: For TRIP-002 filter dimensions whose data is owned by later slices (assigned driver/vehicle/carrier → 006; SLA risk → 007), does 005 build placeholder filter controls? → A: **No (option B).** 005 builds only the **8 data-backed Control Tower filters** (customer, date, status, origin, destination, lane, vehicle type, billing status) + status/billing row indicators, plus a **forward-compatible filter/indicator/view framework**; **slices 006/007 add their own assignment & SLA filters, row indicators, and the "Unassigned"/"At risk" default views** when they deliver the data — 005 ships **no disabled/dead controls** for them. Unchanged by this decision: the **Trip Detail** page still ships placeholder *sections* for assignment/timeline/exceptions/documents/billing (SPEC-SLICING 005 exit criteria), and the **Home Dashboard** still builds all eight §15.2 widgets with placeholder/zero-state for later-slice metrics (REP-001 is wholly owned by 005, and no later slice adds dashboard widgets).

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See, search, and filter every trip in one operating board (Priority: P1)

An operations user opens the **Trip Control Tower** and sees all trips in a dense, readable, sortable table. They type in a persistent search box to jump to a trip by external trip ID, customer, or lane, and they narrow the board with filters — customer, date, status, origin, destination, lane, vehicle type, and billing status — alone or combined. They pick a default view ("Today", "In transit", "Billing pending") to focus instantly. The board refreshes on its own by polling, with clear status colours and at-a-glance indicators for SLA risk, exceptions, and assignment (populated as later slices supply that data).

**Why this priority**: This is the core operating surface and the reason the slice exists — without it no one can run the day from the system. It is a viable MVP on its own and every other story builds on it. *(TRIP-001, TRIP-002, §15.4, §16)*

**Independent Test**: With trips present (created via 003/004), open the Control Tower; confirm all trips render in a dense sortable table; search by external trip ID and by customer and verify the matching row(s) surface; apply each currently-available filter (customer, date, status, origin, destination, lane, vehicle type, billing status) and verify the result set narrows correctly; combine two filters and verify AND semantics; select the "Today" and "In transit" default views and verify the expected subset; reload the page from the URL and verify filters persist; leave the page open and verify it refreshes without manual reload.

**Acceptance Scenarios**:

1. **Given** an authorized user with trips in the system, **When** they open the Control Tower, **Then** the board renders a dense, readable, sortable, paginated table defaulting to the **active/open trips** scope, with all other permitted trips reachable by adjusting filters/views. *(TRIP-001, §15.4, §16; FR-006a)*
2. **Given** the board, **When** the user types an external trip ID, customer name, or lane into the persistent search, **Then** the matching trips are surfaced. *(TRIP-001, §16)*
3. **Given** the board, **When** the user applies any filter among customer, date, status, origin, destination, lane, vehicle type, and billing status, **Then** the list narrows to matching trips. *(TRIP-002)*
4. **Given** the board, **When** the user applies two or more filters together, **Then** only trips matching all active filters are shown. *(TRIP-002)*
5. **Given** the board, **When** the user selects a default view (Today, Next 24 hours, Unassigned, At risk, In transit, Missing documents, Billing pending), **Then** the board applies that view's preset filters. *(§15.4)*
6. **Given** an active set of filters, **When** the user shares or reloads the URL, **Then** the same filtered view is restored. *(§16 — fast filters/saved views; informed default)*
7. **Given** the board is open, **When** trip data changes elsewhere, **Then** the board reflects the change after the next poll without a manual reload, and without depending on Realtime. *(STACK §3.3, §3.10)*
8. **Given** the SLA-risk and assignment filters/indicators in the Control Tower, **When** slice 005 ships, **Then** 005 does **not** build those controls; its forward-compatible filter/indicator/view framework lets slices 007 (SLA) and 006 (assignment) add them with their data, so no invented values or dead controls appear in the interim. *(Scope; Blocked items 1–2; SPEC-SLICING 006/007)*

---

### User Story 2 - Inspect one trip end-to-end on the Trip Detail page (Priority: P1)

From the board (or a direct link) a user opens a trip's **detail page** and sees the complete record in one place: a header (customer, trip ID, lane, status, SLA risk, billing status); the customer plan (the immutable original plan plus the live planned schedule and any recorded actual milestone timestamps); and clearly separated sections for assignment, timeline, exceptions, documents, billing, notes, and audit history. Sections owned by later slices appear as labelled placeholders, but the page never hides them — so the structure is complete from day one.

**Why this priority**: Inspecting a single trip is half the job of a control tower; it is independently testable and required for the MVP operating loop. *(TRIP-003, TRIP-004, §15.5)*

**Independent Test**: From the board, click a trip; verify the detail page loads within the performance target and shows the header fields, the customer plan (original + live planned), and all of: assignment, timeline, exceptions, documents, billing, notes, audit history — each either populated from existing data (plan, status, audit history, timeline events from 003) or shown as a clearly-labelled placeholder (assignment/exceptions/documents/billing/SLA-risk) without inventing data.

**Acceptance Scenarios**:

1. **Given** a trip on the board, **When** the user opens it, **Then** a Trip Detail page opens showing that trip's complete record. *(TRIP-003)*
2. **Given** the Trip Detail page, **When** it renders, **Then** the header shows customer, trip ID, lane, status, SLA risk, and billing status. *(TRIP-004, §15.5)*
3. **Given** the Trip Detail page, **When** the user views the customer-plan area, **Then** it shows the immutable original imported plan alongside the live planned schedule and any recorded actual milestone timestamps, with original-vs-executed clearly separated. *(TRIP-004, §15.5, §16; reuses 003 TRIP-006)*
4. **Given** the Trip Detail page, **When** the user scrolls the record, **Then** it presents distinct sections for assignment, timeline, exceptions, documents, billing, notes, and audit history. *(TRIP-004, §15.5)*
5. **Given** sections owned by later slices (assignment → 006, timeline interaction/exceptions/SLA → 007, documents/billing detail → 008), **When** that data is not yet available, **Then** each section renders as a clearly-labelled placeholder, not as invented or hidden content. *(Scope; Blocked items 1–4)*
6. **Given** the Trip Detail page, **When** the user views audit history, **Then** it shows the trip's audit records (create, plan updates, status changes, cancellation) read-only from the shared audit log. *(TRIP-004; reuses 003 TRIP-007 / 001 audit)*

---

### User Story 3 - Edit operational fields before completion (Priority: P2)

An authorized user (e.g., Operations Manager) notices a planned field needs correcting on a trip that has not yet completed — a pickup window, a vehicle type, a volume — and edits it inline from the detail page (or board). The change is validated, saved through the shared trip domain, recorded in audit history, and reflected on the board on the next poll. After a trip is completed, these fields can no longer be edited.

**Why this priority**: Operations must keep live planned data correct to run execution, but it is secondary to simply seeing trips; it builds on US1/US2 and reuses an existing service. *(TRIP-005, §18)*

**Independent Test**: As a user with edit permission, edit a live planned field on a trip in `received`/`validated` status and verify it saves, appears in audit history, and updates on the board after a poll; attempt the same edit on a `completed` trip and verify it is blocked; attempt the edit as a user without permission and verify it is refused; edit a trip already past `confirmed` and verify the slice-003 authorized-review gate applies.

**Acceptance Scenarios**:

1. **Given** an authorized user and a non-completed trip, **When** they edit a live planned field, **Then** the change is saved through slice 003's plan-update service, the immutable original plan is preserved, and the change is recorded in audit history. *(TRIP-005; reuses 003 TRIP-006/TRIP-007)*
2. **Given** a trip that has reached `completed` (or a later/terminal status), **When** an edit is attempted, **Then** operational-field editing is disabled. *(TRIP-005 — "before completion")*
3. **Given** a user without edit permission, **When** they attempt to edit, **Then** the action is refused and no change is made (BFF-enforced). *(TRIP-005, §18, STACK §5.2)*
4. **Given** a trip already past `confirmed`, **When** an authorized user edits a planned field, **Then** slice 003's authorized-review gate (`REVIEW_REQUIRED`) governs whether the change applies. *(TRIP-005; reuses 003)*
5. **Given** a saved edit, **When** the board next polls, **Then** the updated value is reflected without a manual reload. *(STACK §3.3)*

---

### User Story 4 - Answer "what needs attention today?" from the daily dashboard (Priority: P2)

A manager opens the **Home Dashboard** and immediately sees the day's operational health: trips today by status, trips at risk, unassigned trips, active exceptions, on-time pickup %, on-time arrival %, completed trips missing documents, and billing pending count. Each widget is a doorway — clicking it opens the Control Tower already filtered to those trips, so attention turns into action in one click.

**Why this priority**: This is the manager's primary need ("answer 'what is going wrong today?' within one dashboard", §16), but it depends on the board (US1) and on metrics that later slices compute, so it follows the core read surface. *(REP-001, §15.2, §16)*

**Independent Test**: Open the Home Dashboard; verify all eight §15.2 widgets are present; verify widgets computable now (trips today by status; billing pending count — both derivable from `current_status`) show correct counts against seeded trips; verify widgets whose inputs are owned by later slices (at risk/on-time → 007, unassigned → 006, active exceptions → 007, missing documents → 008) render a clearly-labelled placeholder/zero-state rather than invented numbers; click a populated widget and verify it deep-links to the correspondingly filtered Control Tower.

**Acceptance Scenarios**:

1. **Given** an authorized user, **When** they open the Home Dashboard, **Then** it shows the §15.2 widgets: trips today by status, trips at risk, unassigned trips, active exceptions, on-time pickup %, on-time arrival %, completed trips missing documents, and billing pending count. *(REP-001, §15.2)*
2. **Given** the dashboard, **When** a widget's underlying data exists now (trips today by status; billing pending count), **Then** the widget shows accurate live counts. *(REP-001)*
3. **Given** the dashboard, **When** a widget depends on a later slice's data (SLA/at-risk/on-time → 007, unassigned → 006, exceptions → 007, missing documents → 008), **Then** it renders a labelled placeholder/zero-state, never invented values. *(Scope; Blocked items 1, 2, 4)*
4. **Given** a widget with a count, **When** the user clicks it, **Then** the Control Tower opens filtered to the trips that widget represents. *(§16 — minimal clicks; informed default)*
5. **Given** the dashboard is open, **When** data changes, **Then** widgets refresh by polling. *(STACK §3.3)*

---

### User Story 5 - Export the filtered trip list (Priority: P3)

A user has narrowed the Control Tower to exactly the trips they care about and exports that filtered list to share or work offline. The export contains exactly the rows the current filters select and the columns the user is permitted to see.

**Why this priority**: Useful for hand-offs and ad-hoc reporting, but valuable only on top of working filters (US1); it is the lowest-risk, lowest-priority story. *(REP-005)*

**Independent Test**: Apply filters on the Control Tower, trigger export, and verify the exported file contains exactly the filtered, permitted trips (same count and identity as the on-screen list) with the board's columns; change the filters and re-export and verify the contents change accordingly.

**Acceptance Scenarios**:

1. **Given** a filtered trip list, **When** the user exports it, **Then** the export contains exactly the trips matching the active filters and search. *(REP-005)*
2. **Given** an export, **When** it is produced, **Then** it includes the visible board columns and respects the user's view permissions. *(REP-005, §18)*
3. **Given** no filters, **When** the user exports, **Then** the export reflects the full permitted list (subject to the documented row cap, if any). *(REP-005; Assumptions)*

---

### Edge Cases

- **Empty board / empty view**: a filter combination (or a brand-new environment) that matches no trips shows an explicit empty-state, not a spinner or an error.
- **Large result sets**: the board must remain responsive at daily operating volumes via pagination/virtualization and server-side filtering; the export must define its behaviour for very large lists (cap or stream — see Assumptions).
- **Stale view after edit/transition**: a trip whose status or planned data changed between polls must not present a stale inline-edit affordance; on save conflict, slice 003's optimistic-concurrency error (`STALE_TRANSITION`/review gate) surfaces a clear message.
- **Trip in a status that forbids editing**: edit controls are hidden/disabled for `completed` and later/terminal statuses.
- **Direct link to a non-existent or not-permitted trip**: the detail page returns a clear not-found / not-authorized state, not a partial render.
- **Later-slice data absent**: SLA-risk, assignment, exception, document, and billing-detail elements must render as labelled placeholders, never as `null`/`0` masquerading as real values.
- **Timezone boundaries**: "Today" / "Next 24 hours" views and "trips today" widgets compute day boundaries in `America/Sao_Paulo` while data is stored UTC.
- **Permission downgrade mid-session**: a user whose role no longer permits an action is refused server-side even if a stale client still shows the control (BFF is the authority).

## Requirements *(mandatory)*

### Functional Requirements

**Trip Control Tower — list, search, filter, views (TRIP-001, TRIP-002, §15.4, §16)**

- **FR-001**: The system MUST present permitted trips in a **dense, readable, sortable, paginated** table (operational control-system styling, not marketing). *(TRIP-001, §15.4, §16)*
- **FR-002**: The system MUST provide a **persistent search** that locates trips by external trip ID, customer, and lane. *(TRIP-001, §16)*
- **FR-003**: The system MUST support filtering the trip list by **customer, date, status, origin, destination, lane, vehicle type, assigned driver, assigned vehicle, carrier, SLA risk, and billing status** — the full TRIP-002 set. *(TRIP-002)*
  - **FR-003a**: Filters whose source data exists in the trip read model at this slice (**customer, date (= planned pickup window range), status, origin, destination, lane, vehicle type, billing status**) MUST be fully functional. *(TRIP-002)*
  - **FR-003b**: The four filter dimensions whose source data is owned by a later slice (**assigned driver, assigned vehicle, carrier → slice 006; SLA risk → slice 007**) are **out of scope for slice 005's UI**: 005 MUST provide a **forward-compatible filter framework** (so adding a dimension is configuration/extension, not rework), and **slices 006/007 add their own filter controls and row indicators** into the Control Tower when they deliver that data. 005 MUST build **no disabled or empty placeholder controls** for these four dimensions. *(TRIP-002; Scope; Blocked items 1–2; SPEC-SLICING 006/007 screen ownership)*
- **FR-004**: The system MUST allow **multiple filters to be combined** with AND semantics, alongside the active search term. *(TRIP-002)*
- **FR-005**: The system MUST reflect the active filter/search/view state in the **URL** so a view is shareable and survives reload. *(§16 — fast filters/saved views; informed default)*
- **FR-006**: The system MUST provide the predefined **default views whose data exists at this slice** — **Today, Next 24 hours, In transit, Billing pending** — as selectable, deep-linkable presets, via a **view framework** that lets later slices register the remaining §15.4 views (**Unassigned → 006, At risk → 007, Missing documents → 008**) when their data lands. 005 MUST ship no non-functional view presets. *(§15.4)*
  - **FR-006a**: When the Control Tower is opened with no view or filter selected, it MUST default to the **active/open trips** scope — all non-terminal trips (statuses `received`…`unloaded`), excluding `completed`, `billing_pending`, `billing_ready`, `billed`, and `cancelled` — ordered by planned pickup; completed/billed/cancelled history MUST remain reachable by adjusting filters/views. *(TRIP-001; medium-scale default; §15.4)*
- **FR-007**: Board rows MUST display **status and billing-status** indicators (the data 005 owns/derives). **SLA-risk, assignment, and exception row indicators are added by slices 007/006** when they deliver that data (SPEC-SLICING screen ownership); 005 MUST provide the extensible row-indicator slot/framework but build none of those three itself. *(§15.4; Scope; Blocked items 1–2)*
- **FR-008**: The system MUST keep the board fresh by **polling** with a per-surface, configuration-driven interval — **default: Control Tower 30s, Trip Detail 30s, Home Dashboard 60s** — and MUST NOT depend on Supabase Realtime. *(STACK §3.3, §3.10)*
- **FR-009**: Filtering, sorting, and pagination MUST be enforced **server-side in the BFF** (the authoritative read model), not only in the client. *(STACK §6.2 — read models for operational screens)*
- **FR-010**: The trip list MUST load within the performance target for common filters (see SC-001 / PRD §21.2). *(§21.2)*

**Trip Detail (TRIP-003, TRIP-004, §15.5)**

- **FR-011**: The system MUST let a user **open a Trip Detail page** for any permitted trip, from the board and via direct link. *(TRIP-003)*
- **FR-012**: The detail header MUST show **customer, trip ID, lane, status, SLA risk, and billing status**. *(TRIP-004, §15.5)*
- **FR-013**: The detail page MUST show the **customer plan**: the immutable **original imported plan** alongside the **live planned schedule** and any recorded **actual milestone timestamps**, with original-vs-executed clearly separated. *(TRIP-004, §15.5, §16; reuses 003 TRIP-006)*
- **FR-014**: The detail page MUST present an **assignment** section, shown as a placeholder until slice 006 supplies assignment data. *(TRIP-004, §15.5; Scope)*
- **FR-015**: The detail page MUST present a **timeline** section displaying the trip's recorded events (from slice 003) read-only; interactive timeline editing is owned by slice 007. *(TRIP-004, §15.5, §11.4; Scope)*
- **FR-016**: The detail page MUST present an **exceptions** section, shown as a placeholder until slice 007. *(TRIP-004, §15.5; Scope)*
- **FR-017**: The detail page MUST present a **documents** section, shown as a placeholder until slice 008. *(TRIP-004, §15.5; Scope; Blocked item 4)*
- **FR-018**: The detail page MUST present a **billing** section: the derived billing status is shown now; detailed billing items and billing-readiness reasons are placeholders until slice 008. *(TRIP-004, §15.5; Scope; Blocked item 3)*
- **FR-019**: The detail page MUST present a **notes** section. *(§15.5)*
- **FR-020**: The detail page MUST present **audit history** read-only from the shared audit log (trip create, plan updates, status changes, cancellation). *(TRIP-004, §15.5; reuses 003 TRIP-007 / 001 audit)*
- **FR-021**: The detail page MUST load within the performance target for standard records (see SC-003 / PRD §21.2). *(§21.2)*

**Operational-field editing before completion (TRIP-005, §18)**

- **FR-022**: Authorized users MUST be able to **edit operational (live planned) fields** — planned pickup/delivery windows, planned vehicle type, planned volume/weight/pallets, route notes, service requirements — on a trip that has **not yet completed**, by calling slice 003's existing plan-update service (this slice adds no new trip-write path). *(TRIP-005; reuses 003)*
- **FR-023**: Editing MUST be **permission-gated and BFF-enforced** per PRD §18 "Edit trip plan fields"; the "Limited" scope for Dispatcher/Control Tower is undefined in the PRD and is **blocked for sign-off** (Blocked item 5) — MVP default grants editing to full plan-edit holders (Admin, Operations Manager). *(TRIP-005, §18, STACK §5.2)*
- **FR-024**: Every operational-field edit MUST preserve the **immutable original plan** and be **recorded in audit history**, reusing slice 003's semantics without redefining them. *(TRIP-005; reuses 003 TRIP-006/TRIP-007)*
- **FR-025**: Operational-field editing MUST be **disabled** once a trip reaches `completed` or any later/terminal status. *(TRIP-005 — "before completion")*
- **FR-026**: This slice MUST NOT perform **status transitions, assignment, exception creation, document upload, or billing actions** from the board or detail page — those are owned by slices 006/007/008; status is shown read-only here. *(Scope; SPEC-SLICING 005)*
- **FR-027**: On an edit conflict (e.g., the trip changed since load, or it is past `confirmed`), the system MUST surface slice 003's review/stale outcome (`REVIEW_REQUIRED` / `STALE_TRANSITION`) as a clear, localized message rather than silently overwriting. *(TRIP-005; reuses 003)*

**Home / Daily Dashboard (REP-001, §15.2, §16)**

- **FR-028**: The system MUST provide a **Home Dashboard** with the §15.2 widgets: trips today by status, trips at risk, unassigned trips, active exceptions, on-time pickup %, on-time arrival %, completed trips missing documents, and billing pending count. *(REP-001, §15.2)*
- **FR-029**: Widgets computable from current data (**trips today by status**, **billing pending count**) MUST show accurate live values; widgets depending on later-slice data (at risk/on-time → 007, unassigned → 006, active exceptions → 007, missing documents → 008) MUST render a **labelled placeholder/zero-state**, never invented values. *(REP-001; Scope; Blocked items 1, 2, 4)*
- **FR-030**: Each dashboard widget with a count MUST **deep-link** to the Control Tower filtered to the trips it represents, so a manager can act in one click. *(§16; informed default)*
- **FR-031**: The dashboard MUST refresh by **polling** with a configuration-driven interval (**default 60s**) and MUST NOT depend on Realtime. *(STACK §3.3, §3.10)*
- **FR-032**: "Today"/"Next 24 hours" boundaries and "trips today" computations MUST use the **`America/Sao_Paulo`** business day over UTC-stored timestamps. *(STACK / SPEC-SLICING global constraints)*

**Filtered-list export (REP-005)**

- **FR-033**: Users MUST be able to **export the current filtered trip list** as **CSV**, delivered as a **synchronous download** generated in the BFF; the export MUST contain exactly the trips matching the active filters and search, with the board's columns, and MUST respect the user's view permissions. A **row cap** MUST bound the synchronous export; if the filtered set exceeds the cap, the system MUST prompt the user to narrow filters rather than silently truncate. XLSX and worker-generated export are out of scope (deferred). *(REP-005, §18; STACK — heavy export → worker is slice 008)*

**Authorization, freshness, localization, reuse (cross-cutting)**

- **FR-034**: The system MUST enforce **view access** by **first-enforcing the existing** `view_all_trips` key from the **code-defined permission catalog** (no new key, no DB permissions table — Constitution V), which is already granted to the 7 MVP internal roles; reads are enforced in the BFF, re-gating the trip read endpoints from `manage_trips` → `view_all_trips`. *(§18, STACK §5.2; reuses 001/003/004 catalog pattern — mirrors 004's first-enforcement of `import_trips`)*
- **FR-035**: All user-facing text MUST be **pt-BR** with i18n; timestamps MUST display in `America/Sao_Paulo` while stored in UTC; currency in BRL. *(SPEC-SLICING global constraints, §21.6)*
- **FR-036**: This slice MUST consume the trip domain, status machine, billing projection, and audit semantics from slices 003/004 **read-only** (plus 003's plan-update service for FR-022) and MUST NOT redefine them. *(SPEC-SLICING 005; Constitution)*

### Key Entities *(read models over existing data — this slice introduces no new trip-domain tables)*

- **Trip List Read Model** *(BFF projection over slice 003's `trips` + slice 002 master data)*: the denormalized row the Control Tower displays and filters on — customer (name/code), external trip ID, origin, destination, lane, planned vehicle type, current status, derived billing status, planned pickup/delivery windows, created/updated timestamps. Designed to be **extended** by slices 006/007 with assignment and SLA-risk fields. Supports server-side search, filter, sort, and pagination over the dimensions 005 owns. *(reuses 003 Trip; PRD §15.4)*
- **Trip Detail Read Model** *(BFF composition)*: the complete single-trip record — header fields, the immutable original plan and live planned fields, recorded trip events (timeline), and references/placeholders for assignment (006), exceptions (007), documents (008), billing detail (008), notes, and audit history. *(reuses 003 Trip/Trip Event; PRD §15.5)*
- **Audit History Read Model** *(BFF projection over the shared audit log from 001/003)*: read-only list of a trip's audit records (create, plan update, status change, cancellation) with previous/new values, acting user, and UTC timestamp. *(reuses 003 TRIP-007 / 001 audit)*
- **Dashboard Metrics Read Model** *(BFF aggregation)*: the per-widget counts/percentages for the Home Dashboard, computed from current data where available and exposing labelled placeholders where the owning slice has not yet supplied inputs. *(PRD §15.2; REP-001)*
- **Default View** *(predefined, code/config-defined preset — not a persisted user entity in MVP)*: a named set of preset filters (Today, Next 24 hours, Unassigned, At risk, In transit, Missing documents, Billing pending) selectable on the board and expressible in the URL. User-defined persisted saved views are deferred. *(PRD §15.4; YAGNI)*
- **Trip** *(reused from slice 003 — not redefined here)*: the source of all the above. Operational-field edits (FR-022) flow through slice 003's plan-update service; the original plan stays immutable and changes are audited.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From the Control Tower, a user can locate any specific trip via search or filters, and the list returns within **3 seconds** for common filters at the medium design scale (up to ~10k active trips). *(TRIP-001, TRIP-002, §21.2)*
- **SC-002**: **100%** of the 8 TRIP-002 dimensions whose source data exists at this slice (customer, date, status, origin, destination, lane, vehicle type, billing status) are functional; the remaining four (assigned driver/vehicle/carrier, SLA risk) are **delivered by slices 006/007**, and 005 ships **no invented values and no dead controls** for them. *(TRIP-002)*
- **SC-003**: Any trip opened from the board shows **all ten** §15.5 sections (populated or labelled placeholder) and the detail page loads within **2 seconds** for standard records. *(TRIP-003, TRIP-004, §21.2)*
- **SC-004**: An authorized user can edit an operational field on a non-completed trip; the change is recorded in audit history and visible on the board within **one poll cycle (~30s default)**; an unauthorized user or an edit on a completed trip is refused. *(TRIP-005)*
- **SC-005**: From the Home Dashboard, a manager can identify the trips needing attention today and reach the corresponding filtered Control Tower view in **one click**. *(REP-001, §16)*
- **SC-006**: A user can export the current filtered list **as CSV**, and the export contains **exactly** the filtered, permitted trips shown on screen (same count and identity), up to the documented row cap. *(REP-005)*
- **SC-007**: **No** Control Tower, Trip Detail, or Dashboard view depends on Supabase Realtime; all freshness is via polling. *(STACK §3.3, §3.10)*
- **SC-008**: Across all three screens, **100%** of user-facing labels render in pt-BR and all timestamps display in `America/Sao_Paulo`. *(§21.6)*

## Traceability *(acceptance criteria → PRD)*

| Spec item | Maps to PRD ID / section | Notes |
|-----------|--------------------------|-------|
| US1, FR-001, FR-002, FR-009, FR-010, SC-001 | **TRIP-001**; PRD §15.4, §16, §21.2 | Searchable/filterable dense board; server-side read model |
| US1, FR-003, FR-003a, FR-003b, FR-004, FR-005, FR-006, FR-007, SC-002 | **TRIP-002**; PRD §15.4 | 8 data-backed dims built by 005; assignment & SLA dims delivered by slices 006/007 (no dead controls) |
| US2, FR-011, SC-003 | **TRIP-003**; PRD §15.5 | Open trip detail |
| US2, FR-012–FR-020, SC-003 | **TRIP-004**; PRD §15.5, §11.4 | Header + plan + assignment/timeline/exceptions/documents/billing/notes/audit sections |
| US3, FR-022–FR-027, SC-004 | **TRIP-005**; PRD §18 | Edit operational fields before completion via 003's plan-update service |
| US4, FR-028–FR-032, SC-005 | **REP-001**; PRD §15.2, §16 | Daily dashboard "what needs attention today" |
| US5, FR-033, SC-006 | **REP-005**; PRD §18 | Export filtered trip list |
| FR-008, FR-031, SC-007 | PRD §22 Phase 2; STACK §3.3, §3.10 | Polling-only freshness, no Realtime |
| FR-034, FR-023 | PRD §18; STACK §5.2 | BFF authorization; first-enforces existing `view_all_trips` (no new key); re-gates trip reads from `manage_trips` |
| FR-035, SC-008 | PRD §21.6 | pt-BR, America/Sao_Paulo, BRL |
| FR-036 | PRD §12, §14.1, §19.3; SPEC-SLICING 005 | Reuses 003/004 domain read-only; no redefinition |
| US2 (audit), FR-020 | reuses **TRIP-007** (003); PRD §21.5 | Audit history read-only |
| US2/US3 (plan), FR-013, FR-024 | reuses **TRIP-006** (003); PRD §14.1, §19.1 | Original plan immutable; executed separate |
| Out of scope: quick assignment | DISP-001–009 → slice 006 | Assignment data feeds 005 filters/indicators when 006 lands |
| Out of scope: quick exception / timeline write / SLA compute | EVT/EXC/SLA-001–004 → slice 007 | SLA risk + exceptions + on-time metrics feed 005 when 007 lands |
| Out of scope: documents / billing detail & export | DOC/BILL-* → slice 008 | Document/billing sections are placeholders until 008 |
| Out of scope: advanced reports | REP-002/003/004 → slice 009; REP-006/007/008 Later | Only REP-001/REP-005 owned here |
| Out of scope: bulk update | TRIP-008 → Later | Not in MVP |
| MVP acceptance: "Operations can view and filter all trips" | PRD §23, §22 Phase 2 | This slice satisfies the view/filter acceptance line |

## Scope

### In scope

- Trip **Control Tower** board: dense sortable/paginated table, persistent search, the **8 data-backed TRIP-002 filters** (customer, date, status, origin, destination, lane, vehicle type, billing status) plus a **forward-compatible filter/indicator/view framework** that slices 006/007 extend, the data-backed default views (Today, Next 24 hours, In transit, Billing pending), URL-reflected filter state, **status/billing row indicators**, polling freshness.
- Trip **Detail** page: header, customer plan (original + live + actual timestamps), and sections for assignment, timeline (read-only events), exceptions, documents, billing, notes, and audit history — placeholders where owned by later slices.
- **Operational-field editing before completion** (TRIP-005) via slice 003's existing plan-update service, permission-gated and audited.
- **Home / daily Dashboard** (REP-001) with the §15.2 widgets and one-click deep-links into filtered board views.
- **Export** of the filtered trip list (REP-005).
- **First enforcement** of the existing `view_all_trips` key (no new key); BFF-enforced authorization (re-gates trip reads from `manage_trips` → `view_all_trips`); pt-BR + timezone handling; polling-only freshness.

### Out of scope (owned by later slices)

- **Quick assignment actions** and the assignment data model (slice 006 — DISP-001–009); slice 006 also **delivers** the assignment filter, the "Unassigned" view, the assignment row indicator, and the Trip Detail assignment panel into 005's shell.
- **Quick exception creation, interactive timeline/event writing, and SLA risk computation/recalculation** (slice 007 — EVT/EXC/SLA-001–004); slice 007 also **delivers** the SLA-risk filter, the "At risk" view, and the SLA row indicator into the Control Tower.
- **Document upload/review and billing readiness/rates/export** (slice 008 — DOC/BILL-*); documents and billing detail appear as placeholders.
- **Advanced reports / dashboards** beyond the daily operations dashboard (slice 009 — REP-002/003/004; Later — REP-006/007/008).
- **Bulk update** of trips (Later — TRIP-008).
- **XLSX and worker-generated (async) export** (deferred; the heavy worker-export pipeline is owned by slice 008).
- **Status transitions and any new trip-write path** (owned by 003/006/007); 005 shows status read-only and edits only live planned fields through 003.
- **User-defined persisted saved views** (deferred — YAGNI); MVP ships predefined default views.
- **Customer-scoped row visibility / Customer Viewer role** (post-MVP — Decision §30).

## Assumptions

- **Permitted-to-see at MVP = all trips**: all 7 internal roles have "View all trips" (§18); customer-scoped filtering arrives post-MVP with Customer Viewer. The board is built behind `view_all_trips` so scoping can tighten later without rework.
- **Scale (medium)**: the design target is ~1k–10k active trips on the board and ~50k–500k retained/year; the board uses **server-side pagination and indexed filters** (dense-table row virtualization only if a single page grows large — deferred, YAGNI). Materialized views / partitioning are **not** introduced at MVP (YAGNI) and are revisited only if volume approaches 10k+ active / 1M+ retained.
- **Read models live in the BFF** (STACK §6.2): filtering/sorting/pagination/aggregation are server-side; the client polls. Existing 003 indexes (`customer`, `current_status`, `created_at`, `(customer, external_trip_id)`) back the common filters; additional read-model indexes/views may be added at plan time without changing this spec.
- **Polling intervals** are configuration with documented defaults — **Control Tower 30s, Trip Detail 30s, Home Dashboard 60s** — tuned by Ops; no Realtime.
- **Default views**: 005 ships the data-backed presets (Today, Next 24 hours, In transit, Billing pending) via a **view framework**; slices 006/007/008 **register** the Unassigned / At risk / Missing documents views when their data lands. 005 ships no non-functional view presets.
- **Operational fields = live planned fields** governed by 003's plan-update service; the original plan stays immutable; the post-`confirmed` review gate and audit recording are inherited from 003, not re-implemented.
- **Export** is **CSV** of the on-screen filtered columns, generated **synchronously** in the BFF with a documented **row cap**; over-cap exports prompt the user to narrow filters (no silent truncation). XLSX and worker-generated exports are deferred (the heavy worker-export pipeline is slice 008's).
- **Billing status is the 003 derived projection** (non-null only for billing-phase statuses); the SLA-risk value is read from 007's `sla_status` placeholder until 007 computes it.
- **Desktop-first** operational UI (PRD §16); responsive enough for tablet, but desktop is the MVP design target.

## Dependencies

- **Slice 001 (Platform, Access, App Shell)**: auth/session, BFF auth context, the code-defined permission catalog whose existing `view_all_trips` key this slice first enforces, the audit-log foundation, i18n, and the app shell the three screens mount in.
- **Slice 002 (Master Data)**: Customer, Location, Lane, and fleet (vehicle type) used as filter dimensions and detail-page labels.
- **Slice 003 (Trip Domain & Lifecycle)**: the `trips` model, the 18-value status machine, the billing-status projection, the trip-events (timeline) source, the audit semantics, and the **plan-update service** that FR-022 calls. Consumed read-only except for that service.
- **Slice 004 (Trip Import)**: import batches and the imported customer-plan fields surfaced on the detail page; the board displays trips created/updated by import.
- **Forward dependents (these slices extend 005's shell; not blockers)**: slice 006 **adds** the assigned-driver/vehicle/carrier filters, the assignment row indicator, the "Unassigned" view, and the Trip Detail assignment panel; slice 007 **adds** the SLA-risk filter/indicator and the "At risk" view (and supplies the data for 005's at-risk/on-time dashboard widgets, the exceptions section, and the interactive timeline); slice 008 **adds/fills** the documents and billing-detail sections, the "Missing documents" view, and billing-readiness reasons (and supplies the data for 005's missing-documents dashboard widget).

## Blocked / Open for business sign-off

> Per the feature constraints and Constitution Principle II, this slice ships a **configurable, placeholder-aware** board now; **final sign-off on the items below is BLOCKED** until the corresponding inputs (PRD §29) or upstream slices are delivered. None of these block building the board — they block declaring the affected element final. **No customer, SLA, document, or billing values are invented.**

1. **SLA-risk thresholds & definitions** *(PRD §29 Input #2; §12.2; gates SLA-001/002/003)* — the SLA-status vocabulary (On Track / At Risk / Late / Breached) is defined, but the per-customer thresholds and warning windows are not, and the value is computed by slice 007. The SLA-risk **filter, row indicator, and the "At risk" view are delivered by slice 007** (not built by 005); the **at-risk/on-time dashboard widgets** are built by 005 as placeholders until 007 supplies data; the underlying thresholds remain **blocked for sign-off** until per-customer SLA rules are supplied.
2. **Assignment-based dimensions** *(slice 006 — DISP-001–009)* — assigned driver, assigned vehicle, and carrier are owned by slice 006. The corresponding **filters, the "Unassigned" view, and the assignment row indicator are delivered by slice 006** into the Control Tower (005 provides the extensible framework, not placeholder controls); the **Trip Detail assignment section** is a placeholder shell built by 005 until 006 fills it.
3. **Billing detail & export** *(slice 008; PRD §29 Inputs #4–#5)* — the derived billing **status** is shown/filterable now, but **billing items, billing-readiness reasons, rates, and export format** are owned by slice 008 and gated on the finance export format and billing rules; the billing detail section is a placeholder until then.
4. **Document statuses & "missing documents"** *(slice 008; PRD §29 Input #3)* — per-customer required documents are not yet defined; the **documents section, the "Missing documents" view, and the missing-documents dashboard widget** are placeholders until slice 008 / Input #3.
5. **"Limited" edit-permission scope** *(PRD §18)* — the matrix grants Dispatcher and Control Tower "Limited" edit of trip plan fields, but "Limited" is undefined in the PRD. MVP defaults operational-field editing to full plan-edit holders (Admin, Operations Manager); enabling the **Limited scope for Dispatcher/Control Tower** needs business definition before sign-off.
6. **Saved-views-by-role mapping** *(PRD §15.4)* — the exact role→default-view mapping (and whether user-defined persisted views are needed for MVP) is unspecified; MVP ships predefined default views, and the role mapping / user-defined views need confirmation.
7. **Export row-cap value** *(not specified)* — the export *mechanism* is decided (synchronous CSV with a row cap; over-cap prompts the user to narrow filters — no silent truncation); only the **exact cap value** remains open and will be set at plan time against medium-scale volumes and confirmed with Ops.
