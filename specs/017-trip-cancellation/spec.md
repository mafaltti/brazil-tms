# Feature Specification: Trip Cancellation in Control Tower and Dispatch

**Feature Branch**: `017-trip-cancellation`

**Created**: 2026-07-27

**Status**: Draft

**Input**: User description: "Botão de cancelamento de viagens (protocolos) na Torre de Controle e na Expedição — issue #24 [0001]"

**Origin**: GitHub issue [#24](https://github.com/mafaltti/brazil-tms/issues/24) (internal ID 0001, Notion "Brazil TMS Issues"): operations cannot cancel a trip from the Control Tower or Dispatch screens — no cancel action exists anywhere in the UI.

**Context**: Slice 003 shipped the complete cancellation *domain*: the status machine allows `cancelled` from every non-terminal status through `at_destination` plus `disputed` (PRD §12.1), and a cancellation service enforces the §19.5 data set (reason, responsible party, billing impact, user, timestamp) against config-driven `cancellation_options`, writing an immutable audit record. Nothing exposes it: no screen offers the action and no API path accepts a justified cancellation. This slice is the **exposure layer only** — no status-machine or domain-rule changes.

## Clarifications

### Session 2026-07-27

- Q: PRD §18 marks the Dispatcher's "Cancel trip" as **Limited** (semantics deferred by 001 to the owning feature) — what is the limit? → A: **Dispatch-phase only** — a Dispatcher may cancel only trips in `received`, `assigned`, or `confirmed` (before execution starts); Admin and Ops Manager may cancel any legally cancellable trip. To be recorded in PRD §30.
- Q: Cancellation reasons/billing impacts are config and 003 shipped the reason list empty — seed defaults or stay gated? → A: **Seed a default pt-BR set** (reasons + the three §19.5 billing impacts), usable immediately with business sign-off pending — the slice-007 reason-code precedent. Final production list remains config.
- Q: Besides Trip Detail (Torre) and the Dispatch row, should the Control Tower *list* get a per-row cancel action? → A: **Yes — all three surfaces** (Trip Detail, Dispatch board row, Control Tower list row), consistent with §15.4 "quick status update".

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Cancel a trip from Trip Detail (Priority: P1)

An operations manager (or other authorized user) opens a trip in the Control Tower's Trip Detail page and cancels it: they pick a cancellation reason, classify the responsible party (customer / Brazil Transports / carrier / unknown), select the billing impact, and confirm. The trip becomes **Cancelada**, the justification is stored, and the action appears in the trip's timeline and audit history.

**Why this priority**: Trip Detail is the trip's complete record (PRD §15.5) and the screen shown in the issue's evidence; it is where a deliberate, justified cancellation naturally happens. Delivering it alone already resolves the core of issue #24.

**Independent Test**: With a trip in a cancellable status and a user holding the cancel permission, cancel it from Trip Detail supplying all justification fields; verify the terminal status, stored justification, timeline event, and audit record. Verify a user without the permission never sees the action.

**Acceptance Scenarios**:

1. **Given** a trip in a cancellable status (per PRD §12.1) and a user with cancel permission, **When** they open the cancel action, complete reason, responsible party, and billing impact, and confirm, **Then** the trip status becomes Cancelada, the justification and acting user and timestamp are stored, and a timeline event plus an immutable audit record are created.
2. **Given** the cancel dialog, **When** the user submits without any one of the required elements, **Then** the cancellation is rejected, the trip status is unchanged, and the missing element is indicated.
3. **Given** a user whose role lacks the cancel permission (e.g., the Control Tower role — PRD §18 marks it "No"), **When** they view Trip Detail, **Then** no cancel action is shown, and a direct API attempt is refused.
4. **Given** a trip in a non-cancellable status (e.g., Completed, Billed, already Cancelada), **When** an authorized user views Trip Detail, **Then** the cancel action is not offered, and a direct API attempt is refused as an illegal transition.
5. **Given** a trip in `disputed`, **When** an authorized user cancels it with full justification, **Then** the cancellation succeeds (a legal §12.1 transition).

---

### User Story 2 - Cancel a trip from the Dispatch board (Priority: P2)

A dispatcher working the Expedição queue learns a planned trip will not run (customer called it off, no vehicle available). Directly from the trip's row on the Dispatch board, they cancel it with the same justified flow, and the trip leaves the dispatch queue.

**Why this priority**: The issue explicitly names Expedição. The dispatch queue is where dead trips accumulate today, forcing dispatchers to leave their screen; still, the Trip Detail path (US1) already unblocks them, so this is P2.

**Independent Test**: With a `received` unassigned trip in the dispatch queue and a dispatcher, cancel it from the row; verify the same domain outcome as US1 and that the row leaves the queue on the next data refresh.

**Acceptance Scenarios**:

1. **Given** a trip row in the dispatch queue and a user with cancel permission, **When** they invoke the row's cancel action and complete the justified flow, **Then** the trip is cancelled exactly as in US1 and leaves the queue on the next refresh.
2. **Given** a dispatch-board user without cancel permission viewing the queue, **When** they look at a trip row, **Then** only the actions they are entitled to appear (no cancel action).

---

### User Story 3 - Cancel a trip from the Control Tower list (Priority: P3)

A control-tower operator scanning the Control Tower trip list cancels a trip directly from its row without opening Trip Detail, using the same justified flow. *(Confirmed in scope — clarification 2026-07-27.)*

**Why this priority**: Convenience over an already-covered capability (US1 reaches every trip in the list via its detail page).

**Independent Test**: From the Control Tower list, cancel a cancellable trip via its row action; verify identical domain outcome and list refresh.

**Acceptance Scenarios**:

1. **Given** a cancellable trip row in the Control Tower list and an authorized user, **When** they invoke the row's cancel action and complete the justified flow, **Then** the trip is cancelled exactly as in US1 and the row reflects Cancelada on the next refresh.

---

### Edge Cases

- **Cancellation options not configured**: the reason (and/or billing impact) option lists are config-driven and may be emptied by administrators. The cancel flow must surface a clear "cancellation options not configured" outcome instead of proceeding — never invented values (003 FR-021). This slice seeds a default pt-BR set (clarification 2026-07-27), so the empty state is an operational edge, not the launch state.
- **Concurrent status change**: the trip moves to a non-cancellable status between the user opening the dialog and confirming — the cancellation is refused by the transition guard and the user sees the current status; no partial write.
- **Stale queue rows**: freshness is polling; a row may still show a just-cancelled trip until the next poll. Acting on it hits the same guard and reports the terminal status.
- **Generic status-update loophole**: today the generic status-update path accepts a move to Cancelada with only the milestone-update permission and none of the §19.5 data. Once the justified flow exists, that path must refuse Cancelada as a target so justification can never be bypassed (parallel to how it already refuses assignment statuses).
- **Dispute entry unaffected**: this slice does not change how trips enter or leave `disputed` (other than the already-legal `disputed → cancelled`).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Trip Detail MUST offer a cancel action to users holding the cancel permission whenever the trip's current status legally allows transition to Cancelada (PRD §12.1); the action MUST NOT be offered otherwise. *(issue #24; PRD §15.5)*
- **FR-002**: The Dispatch board MUST offer the same cancel action on each trip row, under the same permission and status rules. *(issue #24; PRD §15.6)*
- **FR-003**: The Control Tower list MUST offer a per-row cancel action under the same rules. *(PRD §15.4; clarification 2026-07-27)*
- **FR-004**: The cancel flow MUST collect, and MUST NOT complete without, all of: a cancellation **reason** chosen from the active configured options, a **responsible party** classification (customer-caused, Brazil Transports-caused, carrier-caused, unknown), and a **billing impact** chosen from the active configured options. *(PRD §19.5; 003 FR-019/FR-021)*
- **FR-005**: The system MUST record the cancelling user and the cancellation timestamp automatically; the user MUST NOT be able to alter either. *(PRD §19.5)*
- **FR-006**: A cancellation missing any required element MUST be rejected with the trip unchanged and the missing element identified. *(003 FR-019)*
- **FR-007**: Only holders of the cancel permission (PRD §18: Admin — yes; Ops Manager — yes; Dispatcher — **Limited**) may cancel; the Control Tower role and all other roles MUST NOT see the action nor succeed via direct request. The Dispatcher's "Limited" is defined (clarification 2026-07-27) as: **a Dispatcher may cancel only trips in the dispatch phase — `received`, `assigned`, or `confirmed`**; attempts on later statuses are refused and the action is not offered. Admin and Ops Manager may cancel any legally cancellable trip. This decision MUST be recorded in PRD §30. *(AUTH-003; PRD §18; 001 FR-008)*
- **FR-008**: The generic status-update path MUST refuse Cancelada as a target status, directing callers to the justified cancellation flow, so that no cancellation can occur without the §19.5 data. *(PRD §19.5 integrity)*
- **FR-009**: Every successful cancellation MUST produce the trip timeline event and the immutable audit record already defined by the domain (previous status, justification fields, acting user, UTC timestamp), and these MUST be visible in Trip Detail's timeline and audit history. *(TRIP-004; 003 FR-015)*
- **FR-010**: A cancelled trip MUST behave as terminal everywhere it already does today: excluded from the dispatch queue and the Control Tower's default active view, operational editing disabled, reachable via history filters. Freshness is the existing polling mechanism — no push/realtime. *(005 FR-006a; 006; constitution)*
- **FR-011**: When the configured cancellation options are absent, the flow MUST fail with a clear "missing configuration" outcome (no invented values), consistent with 003 FR-021.
- **FR-012**: All new UI text MUST ship in pt-BR (labels for the action, dialog fields, option labels, errors), following the existing i18n catalog.
- **FR-013**: The system MUST ship a default pt-BR seed of active cancellation options — a sensible reason set (e.g., cancelled by customer, no vehicle available, weather/road, documentation issue, other) and the three §19.5 billing impacts (no charge, cancellation fee, manual review) — as configurable data with business sign-off pending, mirroring the 007 reason-code precedent. *(PRD §19.5; clarification 2026-07-27)*

### Key Entities *(all existing — no new entities)*

- **Trip**: gains no new attributes; its existing cancellation fields (reason code, responsible party, billing impact, cancelled-at) are populated by this flow.
- **Cancellation Option** *(config, slice 003)*: active, kind-discriminated options (`reason` | `billing_impact`) that feed the dialog's choices; config-driven per the constitution — never hard-coded.
- **Audit Record / Trip Event** *(001/003)*: the immutable trail each cancellation writes; read via existing Trip Detail panels.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An authorized user can cancel a cancellable trip, with full justification, in under 1 minute from both the Control Tower (Trip Detail) and the Dispatch board — resolving issue #24.
- **SC-002**: 100% of cancellations performed through the product carry all five §19.5 elements (reason, responsible party, billing impact, user, timestamp) — zero cancellations can be created without them, via any path.
- **SC-003**: Users without the cancel permission encounter zero affordances to cancel and zero successful cancellations via direct request (permission matrix §18 holds).
- **SC-004**: A cancelled trip disappears from the dispatch queue and the default active Control Tower view within one polling cycle, and its cancellation is visible in its timeline and audit history immediately on next load.

## Assumptions

- The slice-003 cancellation domain (validation, transition guard, event, audit, SLA recompute) is reused exactly as shipped; this slice adds no domain rules beyond closing the FR-008 loophole.
- PRD §12.1/§18/§19.5 already specify this capability — no PRD scope amendment is expected; the only PRD-affecting decision is the Dispatcher "Limited" semantics now fixed by FR-007, to be recorded in §30.
- The seeded cancellation-option list (FR-013) is a working default; final business sign-off on the official list remains open (§29-style), without blocking the feature.
- Bulk cancellation (multi-select) is out of scope; §15.4 bulk selection remains future work.
- Automated cancellation-fee billing is out of scope (PRD §29 item 5, Phase 4); the billing-impact selection only records intent, as slice 003 defined.
- No external notifications on cancellation (email/SMS/webhook are out of MVP scope per 007).
- Customer Viewer and Executive roles remain read-only for trips; nothing here changes their access.
