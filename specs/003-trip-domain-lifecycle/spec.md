# Feature Specification: Trip Domain, Status Machine, and Audit Semantics

**Feature Branch**: `003-trip-domain-lifecycle`

**Created**: 2026-05-29

**Status**: Draft

**Input**: User description: "003 - Trip Domain, Status Machine, And Audit Semantics. The system has a durable trip model, status lifecycle, billing status lifecycle, and audit rules before import and operational screens depend on them."

**Source PRD sections**: §12, §13.4, §14.1, §19.3, §19.5, §21.5, §22 (Phase 2), §23
**Primary requirement IDs**: TRIP-006, TRIP-007
**Slice ownership**: `docs/SPEC-SLICING.md` slice 003 — owns the shared trip domain model and lifecycle semantics that later slices (004 import, 005 control tower, 006 dispatch, 007 execution/SLA, 008 documents/billing, 009 reporting) MUST reuse rather than redefine.

---

## Overview & Intent *(why this feature exists)*

This feature establishes the **shared trip domain** — the durable record of a customer trip, its single enumerated status lifecycle (operational through billing-phase states), the foundation for actual-execution events, and the audit rules that protect critical history. It is a **foundational, mostly headless** slice: it deliberately ships **no operational UI** beyond the minimal internal/admin visibility needed to verify the model. Import (004), the control tower and trip detail (005), dispatch assignment (006), the interactive execution timeline (007), documents and billing export (008), and reporting (009) all build on the domain defined here and **must reuse this status model and audit semantics instead of defining their own**.

The reason this slice comes first: a trip's status, the separation of *planned* (customer) values from *executed* values, and the auditability of critical changes are cross-cutting invariants. If each later screen invented its own status names or audit behavior, the system of record would fragment. This feature locks those invariants down once.

---

## Clarifications

### Session 2026-05-29

- Q: PRD §12.1 prose vs. its transition table disagree on cancelling a trip while In Transit or At Destination — which governs? → A: Follow the prose — `Cancelled` is also a legal transition from `In Transit` and `At Destination`. (Once unloading begins, the trip proceeds to completion or enters `Disputed`; it is not directly cancelled.)
- Q: Is the billing lifecycle a separate state machine or part of the single trip status machine? → A: Single status enum — the billing-phase states (Billing Pending → Billing Ready → Billed, plus Disputed) are the tail of the one `current status` machine (PRD §12.1). Any `billing status` value is a derived projection of `current status`, not an independently-mutated field.
- Q: Which trip field changes must produce an immutable audit record (the default critical-field set)? → A: The documented default set — planned pickup/delivery windows, planned vehicle type, current status, billing status (projection), cancellation reason, and assignment references. Remains configuration-driven; this is the shipped MVP default.

---

## User Scenarios & Testing *(mandatory)*

> Note: "User" here is generally an internal operator/system actor exercising the domain through internal or admin-level access. No customer-facing or full operator UI is in scope; each story is verified through minimal internal/admin visibility (e.g., an admin-only trip inspector and the audit record list).

### User Story 1 - Durable trip with planned vs. executed separation (Priority: P1)

A trip exists as a durable record that carries the **original customer plan** (pickup/delivery windows, requested vehicle type, declared volume/weight/pallets, route notes, service requirements) as an immutable baseline, distinct from any **executed/actual** values produced during operation. The original imported plan is preserved even when a later accepted customer update changes a plan field.

**Why this priority**: This is the bedrock invariant (TRIP-006). Every later feature — import, dispatch, execution, billing — reads or writes against this trip record and relies on the plan-vs-executed separation. Without it nothing else can be trusted.

**Independent Test**: Create a trip from a representative imported plan via internal/admin access; record an executed timestamp; apply an accepted customer update to a planned window. Verify the original planned values are still retrievable unchanged, the executed value is stored separately, and the prior planned value is preserved in the audit log.

**Acceptance Scenarios**:

1. **Given** a trip created from an imported customer plan, **When** an executed/actual value (e.g., actual origin arrival) is recorded, **Then** the original planned values remain unchanged and the actual value is stored separately (as a trip event), so planned and executed can be compared.
2. **Given** a confirmed trip whose customer re-sends an updated plan for the same external trip ID, **When** the update is accepted, **Then** the original imported plan value is preserved, the change is recorded as a "customer update" in the audit log with prior and new values, and the trip's current plan reflects the new value.
3. **Given** a trip past `Confirmed`, **When** a plan field change is attempted, **Then** the system requires an authorized review step before the plan field is updated (the change is not applied silently).

---

### User Story 2 - Explicit, enforced trip status lifecycle (Priority: P1)

Every trip has a **current status** drawn from a single, explicitly enumerated set, and may only move between statuses along **declared legal transitions**. Illegal transitions are rejected. Optional sub-states (Loading, Unloading) may be skipped. Terminal states accept no further transitions.

**Why this priority**: The status machine is the spine of operational tracking and the contract every later slice consumes. It must be explicit and enforced (constitution Principle III: "never free-form strings") before import or the control tower can drive it.

**Independent Test**: Through internal/admin access, drive a trip across the legal path (Received → Validated → Assigned → Confirmed → At Origin → In Transit → At Destination → Unloaded → Completed) and confirm each transition is accepted; then attempt a known-illegal transition (e.g., Received → In Transit) and confirm it is rejected with a clear reason.

**Acceptance Scenarios**:

1. **Given** a trip in `Received`, **When** validation completes successfully, **Then** the trip may move to `Validated` (or to `Validation Error` on failure, or `Cancelled`), and no other target is accepted.
2. **Given** a trip in `At Origin`, **When** the operator skips the optional `Loading` sub-state, **Then** a transition directly to `In Transit` is accepted.
3. **Given** a trip in `Received`, **When** a transition to `In Transit` is attempted, **Then** the system rejects it as an illegal transition and the trip status is unchanged.
4. **Given** a trip in `Cancelled` (terminal), **When** any further transition is attempted, **Then** it is rejected.
5. **Given** a trip in `Disputed`, **When** the dispute is resolved, **Then** the trip returns to the status it was entered from (or, if appropriate, moves to `Cancelled`).

---

### User Story 3 - Critical changes produce immutable audit records (Priority: P2)

Whenever a **critical field** on a trip changes, or a lifecycle action occurs (status transition, plan edit, cancellation), the system writes an **immutable audit record** capturing entity, action, previous value, new value, the responsible user, the timestamp, and an optional reason/note. Audit records cannot be edited or hard-deleted.

**Why this priority**: Auditability is a non-functional invariant (TRIP-007, §21.5, constitution Principle III/IV). It depends on the trip and status model (US1/US2) existing first, hence P2, but is required for MVP acceptance ("Critical changes appear in audit history").

**Independent Test**: Change a critical trip field (e.g., planned vehicle type) and perform a status transition via internal/admin access; confirm each produces exactly one audit record with before/after, actor, timestamp; then confirm audit records cannot be modified or removed through normal operations.

**Acceptance Scenarios**:

1. **Given** a trip with a recorded planned vehicle type, **When** an authorized user edits that field, **Then** an audit record is created with entity = Trip, the previous and new values, the user, and the timestamp.
2. **Given** any trip status transition, **When** it is applied, **Then** an audit (and/or trip event) record captures the previous status, new status, user, and timestamp.
3. **Given** an existing audit record, **When** any actor attempts to alter or delete it, **Then** the operation is refused (records are append-only / soft-archival only).
4. **Given** a non-critical field change (a field not on the configured critical-field list), **When** it is edited, **Then** no critical-change audit record is required (configurable).

---

### User Story 4 - Cancellation requires complete justification (Priority: P2)

A trip can be cancelled only when the actor supplies **all** required justification: a cancellation reason, the cancelling user, the cancellation timestamp, a responsible-party classification, and a billing-impact selection. A cancellation missing any required element is rejected.

**Why this priority**: Cancellation is a high-consequence, audited lifecycle action with downstream billing implications. It depends on the status machine and audit foundation, so P2.

**Independent Test**: Attempt to cancel a trip omitting the responsible-party classification (expect rejection); then cancel with all required elements (expect success, an audit record, and the trip in `Cancelled`).

**Acceptance Scenarios**:

1. **Given** a cancellable trip, **When** a cancellation is submitted with reason, user, timestamp, responsible-party classification, and billing-impact selection, **Then** the trip moves to `Cancelled`, the cancellation reason is stored on the trip, and an audit record captures the action and all inputs.
2. **Given** a cancellation attempt missing any required element, **When** it is submitted, **Then** it is rejected and the trip status is unchanged.
3. **Given** a responsible-party classification, **When** it is selected, **Then** it must be one of the configured allowed values (default set: Customer-caused, Brazil Transports-caused, Carrier-caused, Unknown).
4. **Given** a billing-impact selection, **When** it is chosen, **Then** it must be one of the configured allowed values (the value set is configuration-driven; see Blocked / Open items).

---

### User Story 5 - Billing-phase states live in the single status lifecycle (Priority: P3)

The billing-phase states (Billing Pending → Billing Ready → Billed, with Disputed) are the **tail of the single `current status` machine** (PRD §12.1), not a separate state machine. A `billing status` value, when surfaced for finance filtering, is a **derived projection** of `current status`. This feature owns the billing-phase *states and their legal transitions* (as part of the one machine); the *gating conditions* that decide when a trip may advance into/through them (documents accepted, rate present, disputes resolved, finance confirmation) are owned by later slices and are represented here as configurable predicates that are not enforced in this feature.

**Why this priority**: Establishing the billing-phase vocabulary as part of the single machine now prevents later slices (008) from inventing a divergent, independently-mutated billing machine. Enforcement is deferred, so P3.

**Independent Test**: Through internal/admin access, confirm billing-phase transitions are enforced by the same single-machine transition table (illegal billing transitions rejected), that any `billing status` value is derived from `current status` (not independently settable), and that advancement gating is exposed as configuration (not hard-coded) and marked deferred.

**Acceptance Scenarios**:

1. **Given** a trip whose `current status` is `Completed`, **When** it advances into the billing phase, **Then** it may only follow the single machine's declared billing transitions (Completed → Billing Pending; Billing Pending → Billing Ready; Billing Ready → Billed; any billing-phase state → Disputed; Disputed → the status it was entered from on resolution).
2. **Given** an illegal billing transition (e.g., Billing Pending → Billed), **When** attempted, **Then** it is rejected by the same transition table that governs all statuses.
3. **Given** a `billing status` value surfaced for finance, **When** inspected, **Then** it is a derived projection of `current status` and cannot be set independently of the status machine.
4. **Given** the billing-advancement gating conditions, **When** the model is inspected, **Then** the gating is configuration-driven and explicitly marked as enforced by a later slice (008), not by this feature.

---

### Edge Cases

- **Illegal transition attempt**: any transition not in the declared table is rejected without mutating status, and the rejection is observable (clear reason).
- **Optional sub-state skipping**: `At Origin → In Transit` and `At Destination → Unloaded` are valid (Loading/Unloading skipped).
- **Cancel availability**: cancellation is permitted from any non-terminal status up to and including `At Destination` (resolved by clarification 2026-05-29, following §12.1 prose); attempts from `Cancelled` (terminal), or once the trip is at `Completed` or a later billing-phase state, are rejected — those are handled via `Disputed`. Once `Unloading`/`Unloaded` has begun, the trip proceeds to `Completed` or `Disputed` rather than direct cancellation.
- **Dispute round-trip**: a trip entering `Disputed` records the status it came from and returns there on resolution; `Billed → Disputed` is permitted (Billed is otherwise terminal).
- **Plan update after Confirmed**: re-import / customer update of a plan field on a trip past `Confirmed` requires an authorized review step; the original imported value is always preserved.
- **Warning vs. status**: a validation "warning" is a flag/attention marker on a `Received`/`Validated` trip, **not** a status, and does not block progression.
- **Concurrent transitions**: two actors attempting to change the same trip's status concurrently must not both succeed against stale state; the later write must be reconciled against current status (last-write must re-validate legality).
- **Missing configuration**: if reason-code or billing-impact configuration is absent, the dependent action (cancellation) cannot be completed and the system reports the missing configuration rather than inventing values.

---

## Requirements *(mandatory)*

### Functional Requirements

**Trip record & planned-vs-executed (TRIP-006)**

- **FR-001**: System MUST persist a durable Trip record as the system of record, referencing its customer, external customer trip ID, originating import batch (when applicable), origin, destination, and lane.
- **FR-002**: System MUST store the original customer plan values (planned pickup window start/end, planned delivery window start/end, planned vehicle type, planned volume/weight/pallet count, planned route notes, customer service requirements) and MUST keep them immutable after import.
- **FR-003**: System MUST represent executed/actual values separately from planned values, so planned and executed can be compared without overwriting the plan.
- **FR-004**: When an accepted customer update changes a plan field, System MUST preserve the original imported value (and any prior value) in the audit log and record the change as a "customer update."
- **FR-005**: System MUST require an authorized review step before applying a plan-field change to a trip that is past `Confirmed`.

**Trip Event foundation**

- **FR-006**: System MUST provide a Trip Event record type capturing at minimum: trip reference, event type (standard milestone or custom), status-before, status-after, event timestamp, source, acting user (when manual), optional location, optional notes, and optional related-exception reference.
- **FR-007**: System MUST represent actual milestone timestamps (e.g., origin arrival, loaded, departure, destination arrival, unloaded, completion) as Trip Events rather than as overwritten plan fields. *(Foundation only; the interactive execution timeline UI is out of scope — owned by 007.)*

**Trip status machine**

- **FR-008**: System MUST define `current status` as a single, explicitly enumerated state machine (never a free-form string) using the standard statuses: Received, Validation Error, Validated, Assigned, Confirmed, At Origin, Loading, Loaded, In Transit, At Destination, Unloading, Unloaded, Completed, Billing Pending, Billing Ready, Billed, Cancelled, Disputed.
- **FR-009**: System MUST enforce only declared legal transitions and reject any transition not in the table below, leaving status unchanged on rejection.
- **FR-010**: System MUST treat `Loading` and `Unloading` as optional sub-states that may be skipped (`At Origin → In Transit`, `At Destination → Unloaded`).
- **FR-011**: System MUST allow `Cancelled` from any non-terminal status up to and including `At Destination` (i.e., through arrival, per PRD §12.1 prose), MUST treat `Cancelled` as terminal (no outgoing transitions), and MUST record, for `Disputed`, the prior status so the trip can return to it on resolution. Once `Unloading`/`Unloaded` has begun, the trip proceeds to `Completed` or `Disputed` rather than direct cancellation.
- **FR-012**: System MUST treat a validation "warning" outcome as a non-blocking attention flag, not as a status.

  **Authoritative trip status transition table** (governs FR-009):

  | From | Allowed next |
  |------|--------------|
  | Received | Validated, Validation Error, Cancelled |
  | Validation Error | Received |
  | Validated | Assigned, Cancelled |
  | Assigned | Confirmed, Validated (unassign), Cancelled |
  | Confirmed | At Origin, Cancelled |
  | At Origin | Loading, In Transit, Cancelled |
  | Loading | Loaded, Cancelled |
  | Loaded | In Transit, Cancelled |
  | In Transit | At Destination, Cancelled |
  | At Destination | Unloading, Unloaded, Cancelled |
  | Unloading | Unloaded |
  | Unloaded | Completed |
  | Completed | Billing Pending, Disputed |
  | Billing Pending | Billing Ready, Disputed |
  | Billing Ready | Billed, Disputed |
  | Billed | Disputed |
  | Disputed | (status it was entered from), Cancelled |
  | Cancelled | (terminal — none) |

**Billing-phase states (part of the single status machine)**

- **FR-013**: System MUST model the billing-phase states (Billing Pending, Billing Ready, Billed, Disputed) as part of the single `current status` machine (FR-008), governed by the same transition table (FR-012) — NOT as a separate, independently-mutated state machine. Any `billing status` value exposed for finance filtering MUST be a derived projection of `current status`, never an independently settable field.
- **FR-014**: System MUST expose the conditions that gate advancing `current status` into and through the billing-phase states (documents accepted, rate/amount present, disputes resolved, finance confirmation) as configuration-driven predicates and MUST NOT enforce them in this feature (enforcement is owned by slice 008). The single-machine definition here is the source later slices reuse.

**Audit semantics (TRIP-007, §21.5)**

- **FR-015**: System MUST write an immutable audit record for every change to a configured **critical field** and for every lifecycle action (status transition, plan edit, cancellation), capturing: entity type, entity ID, action, previous value, new value, acting user, timestamp (UTC), and optional reason/note.
- **FR-016**: System MUST make the set of critical fields configuration-driven, with a documented default set for the Trip entity: planned pickup window start/end, planned delivery window start/end, planned vehicle type, current status, billing-status projection, cancellation reason, and (when present) assignment references. This default set is the confirmed MVP default (clarification 2026-05-29).
- **FR-017**: System MUST keep audit and trip-event history append-only: such records MUST NOT be hard-deleted or edited; removal, if ever needed, MUST be soft-delete/archival.
- **FR-018**: System MUST expand (reuse and extend), not replace, the existing Audit Log foundation delivered in slice 001, so all entities share one audit mechanism.

**Cancellation (§19.5)**

- **FR-019**: System MUST require, to cancel a trip, all of: cancellation reason, cancelling user, cancellation timestamp, responsible-party classification, and billing-impact selection; and MUST reject a cancellation missing any of these.
- **FR-020**: System MUST constrain responsible-party classification to a configured allowed set, default: Customer-caused, Brazil Transports-caused, Carrier-caused, Unknown.
- **FR-021**: System MUST treat cancellation reason codes and billing-impact values as configuration-driven (no hard-coded enums); when the configuration is absent, the cancellation MUST fail with a clear "missing configuration" outcome rather than proceeding with invented values.
- **FR-022**: System MUST store the cancellation reason on the trip and record the full cancellation (all inputs) as an audit record.

**Reuse contract**

- **FR-023**: System MUST expose the trip status enumeration, the billing status enumeration, and their transition tables as the single shared definition that later slices (004–009) consume; later slices MUST NOT define their own parallel status sets.

### Key Entities *(include if feature involves data)*

- **Trip**: The durable system-of-record for one customer trip. Holds identifiers (trip ID, external customer trip ID), references (customer, origin, destination, lane, import batch), the immutable original customer plan (windows, vehicle type, volume/weight/pallets, route notes, service requirements), `current status` (an instance of the single trip status enum in FR-008, which includes the billing-phase tail), a derived `billing status` projection of `current status` for finance filtering (not an independently mutated field — see FR-013), a placeholder for SLA status (computed elsewhere — out of scope here), cancellation reason (when cancelled), and created/updated timestamps (stored UTC, displayed America/São_Paulo). Executed values are not stored as overwritten plan fields — they are derived from Trip Events.
- **Trip Event (foundation)**: An append-only record of something that happened to a trip — primarily status changes and actual milestone timestamps. Captures trip reference, event type, status-before/after, event timestamp, source, acting user, optional location, notes, and related-exception reference. This feature establishes the record; the interactive timeline and exception linkage are owned by slice 007.
- **Audit Log (expansion)**: An append-only, immutable record of critical changes across entities — entity type, entity ID, action, previous value, new value, acting user, timestamp, reason/note. This feature expands the slice-001 audit foundation to cover trip critical-field changes, status transitions, plan updates, and cancellations.
- **Status definitions (configuration)**: The single enumerated trip status set (including billing-phase states) and its legal-transition table, plus configuration-driven sets for critical fields, cancellation reason codes, responsible-party classifications, and billing-impact values. (`billing status` is a derived projection of `current status`, not a separate enum.)

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of attempted trip status changes are validated against the declared transition table; every transition not present in the table is rejected with the trip's status unchanged (0 illegal transitions persisted).
- **SC-002**: Original imported plan values are never mutated by execution or by accepted customer updates — for any trip, the originally imported plan remains exactly retrievable, unchanged, for comparison against current and executed values (0 lost originals).
- **SC-003**: Every change to a configured critical field, and every status transition, produces exactly one corresponding immutable audit record capturing before/after values, the acting user, and a timestamp (no critical change is unlogged; no audit record is editable or hard-deletable).
- **SC-004**: 100% of trip cancellations contain all five required justification elements (reason, user, timestamp, responsible-party classification, billing-impact selection); any cancellation missing one is rejected (0 incomplete cancellations persisted).
- **SC-005**: Exactly one trip status enumeration exists (the single machine in FR-008, including the billing-phase tail), reused as the one shared definition; no second, independently-mutated status or billing machine exists, and any `billing status` value is a derived projection of `current status`.
- **SC-006**: Actual milestone timestamps are retrievable as trip events for a trip and are distinguishable from that trip's planned windows (planned-vs-actual comparison is possible for every recorded milestone).

---

## Traceability *(acceptance criteria → PRD)*

| Spec item | Maps to PRD ID / section | Notes |
|-----------|--------------------------|-------|
| US1, FR-002, FR-003, FR-004, SC-002 | **TRIP-006**; PRD §12, §14.1 (planned vs executed), §19.1 (re-plan) | Original plan immutable; executed stored separately |
| US1 (scenario 2/3), FR-004, FR-005, US3, FR-015–FR-018, SC-003 | **TRIP-007**; PRD §21.5 (Auditability); §19.3 | Customer + internal changes audited; append-only |
| US2, FR-008–FR-012, SC-001, SC-005 | PRD §12 / §12.1 (status machine & transitions); §13.4 | Explicit enumerated status + legal transitions |
| FR-006, FR-007, SC-006 | PRD §13.7 / §14.1 (Trip Event); EVT-002, EVT-004, EVT-005 | Actual timestamps as events (foundation only; EVT-* requirements owned/consumed by slice 007) |
| US5, FR-013, FR-014 | PRD §12.1 (single machine, billing tail); §13.4 / §14.1 (billing-status field → derived projection); §19.4 (gating, deferred to 008) | Billing-phase states are the tail of the one machine; gating deferred |
| US4, FR-019–FR-022, SC-004 | PRD §19.5 (cancellation rules) | Required inputs + classifications |
| FR-016, FR-021, FR-023 | PRD §21.5; constitution Principle V (config over code); §22 Phase 2 status model | Config-driven; shared definition reused by later slices |
| Out-of-scope items | PRD §22 phasing; `docs/SPEC-SLICING.md` slices 004–009 | UI/enforcement owned later |
| MVP acceptance linkage | PRD §23 ("Critical changes appear in audit history"; "Trip timeline shows planned and actual events") | This slice provides the model these acceptance items depend on |

---

## Scope

### In scope

- Durable Trip record with planned-vs-executed separation and preserved original plan.
- Explicit, enforced trip status state machine and legal-transition table.
- Billing-phase states as the tail of the single status machine (states + legal transitions) and a derived billing-status projection; gating exposed as configurable, not enforced here.
- Trip Event record foundation (actual timestamps as events).
- Audit Log expansion covering trip critical-field changes, status transitions, plan updates, cancellations (immutable/append-only).
- Cancellation semantics (required justification, configurable reason/billing-impact, responsible-party classification).
- Minimal internal/admin-only visibility sufficient to verify the model.
- Shared status/audit definitions that later slices reuse.

### Out of scope (owned by later slices)

- Import UI and import engine (slice 004).
- Control tower, trip list, trip detail UI, daily dashboard (slice 005).
- Dispatch assignment and conflict warnings (slice 006).
- Interactive execution timeline, exception lifecycle, SLA-risk computation and alerts (slice 007).
- Documents, completion validation, billing-readiness **enforcement**, rates, billing export (slice 008).
- Reporting and audit-history **views** (slice 009).
- SLA status *calculation* (a placeholder field may exist; computation is not in this slice).

---

## Assumptions

- The standard trip status set in PRD §12.1 is authoritative for MVP. The §12.1 prose-vs-table conflict on cancellation availability is resolved (clarification 2026-05-29): cancellation is legal from any non-terminal status through `At Destination`, per the prose. The billing-phase states are the tail of this single machine — there is no separate billing state machine (clarification 2026-05-29).
- The Audit Log foundation and authenticated user/role context from slice 001 exist and are reused; master-data entities (Customer, Location, Lane, Driver, Vehicle, Carrier) from slice 002 are referenceable.
- Authorization is enforced server-side, consistent with the constitution; this spec describes behavior, not the enforcement mechanism.
- Timestamps are stored in UTC and displayed in America/São_Paulo; currency is BRL — relevant only where billing-impact values are surfaced.
- "Authorized review" for post-`Confirmed` plan edits means a permission-gated action; the exact role mapping is owned by the access model and is configurable.
- Customer-specific variation (reason codes, billing-impact values, status-label display) is configuration-driven, never per-customer code.
- No customer, SLA, document, or billing detail has been invented: where the PRD leaves a value set open, this spec defines it as configuration with a documented default and flags final sign-off as blocked.

## Dependencies

- **Slice 001 (Platform, Access, App Shell)**: authenticated user/role context, audit-log foundation, i18n/app shell. Reused, not rebuilt.
- **Slice 002 (Master Data & Operational Configuration)**: Customer, Location, Lane, Driver, Vehicle, Carrier entities referenced by Trip.

## Blocked / Open for business sign-off

> Per the feature constraints, the model is configurable now and **final sign-off is BLOCKED** until these business inputs are confirmed. Neither blocks building the configurable model; they block declaring the domain final. (Two earlier items — cancellation availability vs. status, and the critical-field default set — were resolved in the 2026-05-29 clarification session.)

1. **Cancellation billing-impact value set** — PRD §19.5 lists values non-exhaustively ("such as no charge, cancellation fee, or manual review") and PRD §25 keeps "How are cancellations charged?" open. The allowed set is configuration-driven with that default; the final enumeration needs finance/business confirmation.
2. **Cancellation reason codes** — config-driven (Reason Code entity), default set not enumerated in the PRD; needs business confirmation of the initial code list.
