# Feature Specification: Trip Validation Action & Dispatch Queue Hardening

**Feature Branch**: `010-trip-validation-dispatch-fix`

**Created**: 2026-06-02

**Status**: Draft

**Input**: User description: "Close the received→validated trip-lifecycle gap and harden the dispatch queue so that imported or manually-created trips (which always land in 'received') can be made assignable through the UI. Today a 'received' trip appears in the Dispatch Board queue but every assignment attempt fails with ILLEGAL_TRANSITION, and there is no shipped product action that performs received→validated (the transition is legal in the status machine and the generic status endpoint already accepts it under `update_trip_status`, but no UI button or automatic step ever fires it). Closes GitHub issue #11. Scope: (a) an explicit, permission-gated Validate action that moves a 'received' trip to 'validated' (and the validation_error→received correction), reusing the existing transition service + `update_trip_status` permission — no new permission key, table, enum, migration, dependency, or worker job; (b) tighten the Dispatch Board queue to show only assignable trips; (c) replace the client-driven assign/reassign branch so a non-assignable status returns a clear 'must be validated first' message instead of the misleading reassignment-only ILLEGAL_TRANSITION; (d) refresh the demo/e2e seed so at least one trip reaches 'validated'. Do NOT auto-validate on import (out of MVP scope — erases the §12.1 Warning-review beat; YAGNI). Do NOT invent validation criteria — import (slice 004) already performed the §11.2 checks and does not transition trips. Builds on shipped slices 003, 005, 006; adds nothing durable."

**Source PRD sections**: §11.2 (Trip Validation Workflow — checks performed at import), §11.3 (Dispatch & Assignment Workflow), §11.4 (Trip Detail), §12 (Trip Status Lifecycle), §12.1 (Allowed Status Transitions — `Received → Validated`, owner "System validation / Operations", and the Warning-flag note), §13.5 (Trip Assignment), §18 (Permissions), §21.4 (Least Privilege), §21.5 (Auditability), §23 (MVP Acceptance — a trip can be assigned through the product flow), §29 (gated business inputs — referenced, not blocking), §30 (Decision Log)

**Primary requirement IDs**: TRIP-006, TRIP-007 (003 — status machine & legal transitions), DISP-001 (006 — assign a resource to a trip). Closes **GitHub issue #11**.

**Slice ownership**: This is a **corrective close-out slice** that fixes a defect spanning **shipped** slices and closes a product-flow gap; it is **slice 010** in the delivery sequence, not one of the nine originally-planned slices in `docs/SPEC-SLICING.md`. It closes **GitHub issue #11**: an imported or manually-created trip is always created in **`received`** (the `createTrip` default, slice 003) and **no shipped product surface advances it to `validated`** — so it can never be assigned through the UI even though `received → validated` is a **legal transition** in the single status machine (slice 003) and the generic status endpoint already performs it. It owns three behavior fixes plus a seed refresh, and **adds NOTHING durable**: **NO new permission key, table, enum, migration, package, runtime dependency, or worker job.** (1) **Validate action** — an explicit, permission-gated operator action that performs **`received → validated`** (and the **`validation_error → received`** correction), surfaced on the **Trip Detail** screen (slice 005, §11.4) where a `received` trip is otherwise actionless; it **reuses** the existing single status-transition service (`transitionTripStatus`, slice 003 — which already writes the append-only `trip_events` + `audit_logs` rows and recomputes SLA) and the existing **`update_trip_status`** permission key (introduced for execution milestones in slice 007). It is **not** a new endpoint, service, or permission — it is a UI affordance over the existing status-transition path, and per **Constitution III** it **never re-derives or re-implements** the status machine (the legal-transition table in `packages/shared/src/domain/trip-status.ts` stays the single source of truth). (2) **Dispatch queue hardening** — the Dispatch Board assignment queue (slice 006, §11.3) is narrowed from the broad **active-status** scope (which lists `received`, `in_transit`, and other non-assignable statuses) to **only the assignable status (`validated`, unassigned)**, so the queue stops surfacing trips that cannot be assigned from it. (3) **Assignment error clarity** — the assignment route (slice 006, §13.5) currently selects assign-vs-reassign from a client-supplied "expected from" status and silently routes a `received` trip into the reassignment path, which rejects it with the misleading **`ILLEGAL_TRANSITION`** ("reassignment only") message; this slice makes the route return a **distinct, accurate** error for any non-assignable status ("the trip must be validated before assignment"). (4) **Seed refresh** — the demo/e2e seed (slice 003 sample data) advances at least one demo trip to **`validated`** (and ideally one to **`assigned`**) **through the transition service** (never a raw status write), so the hardened queue and the dispatch flow are demonstrable and testable end to end. Authorization adds **NO new key**: the Validate action reuses **`update_trip_status`** (Admin, Operations Manager, Dispatcher, Control Tower — a superset of the §12.1 "System validation / Operations" owner), and assignment continues to use **`assign_resources`** (006). Freshness is **polling** (no Realtime). It builds on `specs/003-trip-domain-lifecycle/` (the `trip_status` machine, the `received → validated` legal edge, `transitionTripStatus`, append-only `trip_events`/`audit_logs`), `specs/005-control-tower/` (the Trip Detail screen the Validate action is surfaced on), and `specs/006-dispatch-assignment/` (the Dispatch Board queue and the assignment route/error this slice hardens). Per **Constitution II** no missing business input is invented: at MVP `received → validated` is a **deliberate operator promotion**, since import (slice 004) already performs the §11.2 data checks and explicitly does **not** transition trips; whether the promotion should later become automatic or carry per-customer validation rules is recorded as a deferred product decision, **not** built here.

## Overview & Intent *(why this feature exists)*

Slices 003–008 take a trip from import through dispatch, execution, exceptions, completion, proof, and billing. But there is a **broken seam at the very start of the operational flow**: every trip is created in **`received`** (import never advances it — slice 004's documented behavior — and `createTrip` has no other starting state), yet **nothing in the shipped product moves a trip out of `received`**. The status machine permits `received → validated`, and the generic status endpoint already performs it under `update_trip_status`, but there is **no button, no screen action, and no automatic step** that fires it. The Trip Detail timeline only offers execution milestones (`at_origin … completed`), so a `received` trip shows **no status control at all**; the Dispatch Board's assignment panels only render for already-`validated`/`assigned`/`confirmed` trips.

The visible symptom (GitHub issue #11) is that the **Dispatch Board lists trips it cannot assign**: its queue is scoped to *all active statuses* (including `received` and `in_transit`), so a dispatcher sees a `received` trip in "Fila de atribuição", clicks **Atribuir**, and gets a red **"Operação não permitida para o status atual da viagem."** The deeper cause is the missing `received → validated` step; the misleading error and the over-broad queue are the two surfaces that make the gap user-hostile.

This slice closes the gap with the **smallest correct change** (Constitution I): a single **Validate** action that reuses the existing transition service and permission, a **one-line narrowing** of the dispatch queue to the only status it can act on, and a **clearer error** for the residual edge cases. It deliberately does **not** add auto-validation on import (that would erase the §12.1 review beat where a Warning-flagged trip is examined before becoming assignable) and does **not** invent validation rules (import already ran the §11.2 checks). The value is a **coherent, demonstrable operational flow**: an imported trip can be validated and assigned entirely through the UI, and the dispatch queue tells the truth about what is assignable.

## Clarifications

### Session 2026-06-02 *(design decisions resolved while specifying; informed defaults grounded in PRD §11.2/§12.1 and the issue-#11 root-cause analysis)*

- Q: Does this slice add any new permission key for the Validate action? → A: **No new key.** The Validate action reuses **`update_trip_status`** — the existing key that already gates the generic status-transition endpoint and the execution-milestone recorder (slice 007). Its holders (Admin, Operations Manager, Dispatcher, Control Tower) are a **superset** of the §12.1 owner "System validation / Operations", which is appropriate. No `validate_trip` key is created. *(Constitution IV; §18/§21.4)*
- Q: Is `received → validated` an automatic step (e.g., on import success) or a manual operator action? → A: **Manual operator action** for MVP. Auto-validation on import is **out of scope**: it would contradict slice 004's documented "import does not transition trips" invariant and erase the §12.1 **Warning-flag review beat** (a trip flagged Warning at import is meant to be examined before it becomes assignable). Automatic promotion is recorded under Future Enhancements. *(Constitution I/II; PRD §11.2 outcomes, §12.1 note)*
- Q: Does the Validate action re-run the §11.2 validation checks (customer active, windows valid, vehicle type present, duplicate, …)? → A: **No.** Those checks already run at **import** (slice 004) and an error row is never applied, so an applied/created trip is by construction already "valid". At MVP `received → validated` is a **deliberate promotion, not a validation engine** — no validation criteria are invented or re-evaluated. Per-customer validation rules are a deferred product decision. *(Constitution II; PRD §11.2)*
- Q: How does the status change get persisted — is a new write path needed? → A: **No.** The action routes through the existing **single** status-transition service (`transitionTripStatus`, slice 003), which already performs the optimistic-concurrency-guarded status update, the append-only **`trip_events`** `status_change` row, the **`audit_logs`** record, and the SLA recompute — atomically. The slice **never** introduces a parallel status-write path or re-implements the status machine. *(Constitution III)*
- Q: What exactly should the Dispatch Board queue show after hardening? → A: **Only assignable trips: `validated` and unassigned.** `assigned`/`confirmed` trips are already excluded from this queue (it filters to unassigned), and reassignment is initiated from the **Trip Detail** assignment panel and the Control-Tower quick-assign, **not** from the board queue — so narrowing to `validated` removes only non-actionable noise (`received`, `in_transit`, and other in-flight statuses), with **no loss of any reassignment flow**. In-flight visibility remains the Control Tower's job. *(PRD §11.3; issue #11 root-cause #2)*
- Q: What should the assignment route return when a trip is neither `validated` nor `assigned`/`confirmed`? → A: A **distinct, accurate** conflict result meaning "the trip must be validated before it can be assigned", for **all** non-assignable statuses (not only `received`) — replacing the current behavior where such a trip is silently routed to the reassignment path and rejected with the "reassignment only" `ILLEGAL_TRANSITION` message. The new message is **defense-in-depth**: once the queue is narrowed (fix b), a non-assignable trip should not normally reach the route, but a direct call or a stale board row still gets an honest answer. *(PRD §13.5; issue #11 root-cause #1)*
- Q: Is anything in this slice gated on a PRD §29 business input? → A: **No hard gate.** The §29 inputs (per-customer SLA rules, document/billing rules) do not affect this slice's behavior. The only adjacent open question — whether validation should later be automatic or carry per-customer rules — is a **product decision deferred to the backlog**, not a §29 business-input gate, and does not block this slice. *(Constitution II)*

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Validate a received trip so it can be assigned (Priority: P1)

An operator (Operations Manager, Dispatcher, Control Tower user, or Admin) opens the **Trip Detail** screen of a trip that is in **`received`** and sees a clear **Validate** ("Validar") action. Activating it moves the trip to **`validated`**, records the change in the trip's history, and makes the trip eligible for assignment. The action is **only** available to users permitted to change trip status, and **only** for trips actually in a state from which validation is legal.

**Why this priority**: This is the **primary gap** and the root cause of issue #11 — without it, no imported or created trip can ever leave `received`, and the entire downstream flow (assign → execute → bill) is unreachable through the product. It is independently valuable and shippable: even before the queue/error fixes, it unblocks the operational flow.

**Independent Test**: Seed (or import) a trip in `received`. As a user **with** the status-change permission, open Trip Detail and confirm the Validate action is shown; activate it and assert the trip becomes `validated`, a status-change history record is written, and the trip is now assignable. As a user **without** the permission, assert the action is not available / is refused. Assert the action is **not** shown for a trip already past `received`/`validation_error`.

**Acceptance Scenarios**:

1. **Given** a trip in `received` and a user with `update_trip_status`, **When** the user activates Validate on Trip Detail, **Then** the trip transitions to `validated`, an append-only status-change history entry is recorded, and the trip becomes eligible for assignment. *(TRIP-006/007, §12.1, §21.5)*
2. **Given** a trip in `validation_error` and a permitted user, **When** the user activates the correction action, **Then** the trip returns to `received` (per the legal transition) and can be validated again after the underlying data is corrected. *(§12.1)*
3. **Given** a user **without** `update_trip_status`, **When** they view Trip Detail for a `received` trip, **Then** the Validate action is not available to them and any direct attempt is refused. *(§18, §21.4)*
4. **Given** a trip **not** in `received`/`validation_error` (e.g. already `validated`, `assigned`, or `in_transit`), **When** the user views Trip Detail, **Then** the Validate action is not offered (the action is status-scoped). *(§12 status machine)*

---

### User Story 2 — The dispatch queue lists only assignable trips (Priority: P1)

A dispatcher opens the **Dispatch Board** and the assignment queue ("Fila de atribuição") shows **only trips that can actually be assigned from it** — `validated` trips awaiting a resource. Trips still in `received` (not yet validated) or already in flight (`in_transit`, etc.) no longer clutter the queue, so every row the dispatcher sees is genuinely actionable.

**Why this priority**: This removes the user-facing symptom of issue #11 — clicking **Atribuir** on a row and getting an error. It must ship **together with** Story 1: on its own it would correctly empty the queue of all currently-seeded trips (none are `validated`), so the two together restore a working, honest queue.

**Independent Test**: Seed trips across multiple statuses (`received`, `validated` unassigned, `in_transit`, and an `assigned` trip). Open the Dispatch Board and assert the queue contains **only** the `validated`, unassigned trip(s) — no `received`, no `in_transit`, no already-assigned trips. Assert clicking Assign on a queued (`validated`) trip succeeds.

**Acceptance Scenarios**:

1. **Given** trips in a mix of `received`, `validated` (unassigned), `in_transit`, and `assigned`, **When** a dispatcher opens the Dispatch Board, **Then** the assignment queue lists only the `validated`, unassigned trips. *(§11.3; issue #11 root-cause #2)*
2. **Given** a `validated`, unassigned trip in the queue, **When** the dispatcher assigns a driver + vehicle, **Then** the assignment succeeds and the trip leaves the queue. *(DISP-001)*
3. **Given** no trip is currently `validated`, **When** the dispatcher opens the Dispatch Board, **Then** the queue is empty (honest "nothing to assign") rather than populated with non-assignable trips. *(§11.3)*

---

### User Story 3 — A clear message when a trip cannot yet be assigned (Priority: P2)

If an assignment is attempted for a trip that is **not** in an assignable state (because the queue was stale, or via a direct request), the system responds with a **clear, accurate** message — that the trip must be **validated** before it can be assigned — rather than the misleading "reassignment only" / generic illegal-transition error. The message points the user toward the correct next step (validate the trip first).

**Why this priority**: Defense-in-depth and correctness, but lower priority because once Stories 1–2 ship, a non-assignable trip should not normally reach this path. It still matters for direct API callers, race conditions, and to stop the confusing error from ever being shown.

**Independent Test**: Issue an assignment for a trip in `received` (and separately for an `in_transit` trip). Assert the response is a conflict whose meaning is "must be validated before assignment" — a distinct, accurate result — and that no assignment is created. Assert the user-facing text is the localized "must be validated first" message, not the reassignment-only message.

**Acceptance Scenarios**:

1. **Given** a trip in `received`, **When** an assignment is attempted, **Then** the request is refused with a clear "the trip must be validated before assignment" message and no assignment is created. *(§13.5; issue #11 root-cause #1)*
2. **Given** a trip in an in-flight status (e.g. `in_transit`), **When** an assignment is attempted, **Then** the same clear "not assignable in its current status" outcome is returned (the route handles **all** non-assignable statuses, not only `received`). *(§13.5)*
3. **Given** a `validated` trip, **When** an assignment is attempted, **Then** it still succeeds (the new branch does not regress the normal assign or the existing reassign-from-`assigned`/`confirmed` flow). *(DISP-001, regression guard)*

---

### Edge Cases

- **Concurrent validate / status change**: two users (or a user and a background recompute) act on the same `received` trip — the optimistic-concurrency guard in the existing transition service must make the second attempt fail cleanly (stale), not double-apply. *(reuses existing guard)*
- **Validate on a non-`received` trip via a stale UI**: the action submitted for a trip whose status already changed must be refused with a clear stale/illegal result, not silently applied.
- **Assign on a stale queue row**: a board row that was `validated` when rendered but has since changed status must produce the clear non-assignable message (Story 3), not a misleading one.
- **`validation_error` trips**: must be reachable for the `validation_error → received` correction and must **not** appear in the dispatch queue (they are not `validated`).
- **Empty queue is valid**: when no trip is `validated`, the dispatch queue is legitimately empty — the UI must present this as "nothing to assign", not an error or a perpetual loading state.
- **Audit fidelity of the source field**: a validate performed through the operator UI must record the change with an operator-attributable source (not defaulted to "system"), so audit history distinguishes an operator promotion from an automated one.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide an explicit operator action that transitions a trip from **`received`** to **`validated`**, surfaced on the Trip Detail screen and available only when the trip is in a state from which validation is legal (`received`). *(TRIP-006/007, §11.4, §12.1)*
- **FR-002**: The system MUST also provide the **`validation_error → received`** correction transition through the same surface, so a trip flagged in error can be returned for re-validation after correction. *(§12.1)*
- **FR-003**: The Validate (and correction) action MUST be authorized by the existing **`update_trip_status`** permission and refused for users without it; **no new permission key** is introduced. *(§18, §21.4, Constitution IV)*
- **FR-004**: The transition MUST be performed through the existing single status-transition service so that it produces the standard append-only **status-change history** (trip event) and **audit record**, atomically, and triggers the standard SLA recompute — the slice MUST NOT create a parallel status-write path or re-implement the status machine. *(§21.5, Constitution III)*
- **FR-005**: The transition MUST be recorded with an **operator-attributable source** (the action is a manual operator promotion), distinguishable in history from an automated/system change. *(§21.5)*
- **FR-006**: The Dispatch Board assignment queue MUST list **only assignable trips** — `validated` trips that have no current assignment — and MUST NOT list trips in `received`, `validation_error`, or any in-flight status. *(§11.3)*
- **FR-007**: Narrowing the dispatch queue MUST NOT remove any legitimate flow: reassignment of `assigned`/`confirmed` trips is initiated from Trip Detail / Control-Tower quick-assign (not the board queue) and MUST continue to work; in-flight trip visibility remains on the Control Tower. *(§11.3, regression guard)*
- **FR-008**: When an assignment is attempted for a trip that is **not** in an assignable state (anything other than `validated` for a new assignment, or `assigned`/`confirmed` for a reassignment), the system MUST refuse it with a **distinct, accurate** result meaning "the trip must be validated before assignment", for **all** non-assignable statuses — not the prior misleading "reassignment only" / generic illegal-transition message. *(§13.5)*
- **FR-009**: The clear non-assignable message MUST be presented to the user in the production UI language (pt-BR) and MUST NOT degrade to a generic "request failed" fallback. *(§21.6)*
- **FR-010**: The assignment route MUST continue to assign `validated` trips and reassign `assigned`/`confirmed` trips exactly as before (no behavior regression for the valid paths). *(DISP-001, regression guard)*
- **FR-011**: The demo/e2e seed MUST produce at least one trip in **`validated`** (and SHOULD produce at least one in **`assigned`**), advanced **through the transition service** (never a raw status write), so the validated→assigned flow and the hardened queue are demonstrable and testable end to end. *(Constitution III; supports SC verification)*
- **FR-012**: The slice MUST NOT add any new permission key, table, enum, database migration, runtime dependency, package, or worker job, and MUST NOT use Realtime (freshness stays polling). *(Constitution I/IV; STACK exclusions)*
- **FR-013** *(explicit non-requirement)*: The system MUST NOT auto-validate trips on import success in this slice, and MUST NOT introduce or re-run per-trip validation criteria at validate-time; `received → validated` is a deliberate operator promotion. *(Constitution I/II; §11.2, §12.1)*

### Key Entities *(no new entities — existing only)*

- **Trip**: reuses the existing `trip_status` lifecycle; this slice only exercises the already-legal `received → validated` and `validation_error → received` edges. No schema change.
- **Trip Event / Audit Log**: reuses the existing append-only status-change event and audit record written by the transition service. No new event type, no schema change.
- **Trip Assignment**: unchanged; this slice only changes which trips are *offered* for assignment and how a non-assignable attempt is *reported*.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can take an imported/created trip from `received` to **assigned entirely through the UI** (validate, then assign) with **no direct API call, database edit, or workaround** — the end-to-end flow that is impossible today. *(closes issue #11)*
- **SC-002**: After a validate, the trip appears in the Dispatch Board assignment queue and can be assigned; **100%** of trips shown in the queue are assignable (zero rows produce a status error on assign). *(US2)*
- **SC-003**: A permitted user sees the Validate action on a `received` trip; a non-permitted user never can, and a direct attempt by a non-permitted user is refused. **No** trip status changes without an authorized actor and an audit record. *(US1, §21.4, §21.5)*
- **SC-004**: Every validate (and correction) produces exactly one append-only status-change history entry and one audit record attributable to the acting operator. *(§21.5)*
- **SC-005**: Attempting to assign a non-assignable trip yields a **clear, correct** "must be validated first" message in pt-BR — the misleading "reassignment only" message is no longer reachable for a `received`/in-flight trip. *(US3, §21.6)*
- **SC-006**: The valid assign and reassign flows continue to work unchanged (no regression), verified by the existing dispatch acceptance tests passing against the refreshed seed. *(US3 scenario 3, FR-010)*
- **SC-007**: The change introduces **no** new permission key, table, enum, migration, dependency, package, or worker job (verifiable by diff/schema review). *(FR-012, Constitution I)*

## Assumptions

- The production UI language is **pt-BR**; there is no `en` message catalog in the repo, so user-facing text is added in pt-BR only.
- The status machine already declares `received → validated`, `received → validation_error`, `validation_error → received`, and `validated → assigned` as legal transitions (slice 003); this slice exercises them but does not change the machine.
- The existing status-transition service already enforces optimistic concurrency, writes append-only history + audit, and recomputes SLA; reusing it gives correct persistence and audit "for free".
- The Dispatch Board queue already filters to unassigned trips (so `assigned`/`confirmed` are excluded); the only change needed is to scope it to `validated` instead of all active statuses.
- Reassignment is initiated from Trip Detail / Control-Tower quick-assign, not from the board queue — so narrowing the queue does not remove any reassignment entry point.
- Holders of `update_trip_status` (Admin, Operations Manager, Dispatcher, Control Tower) are an acceptable audience for the Validate action (a superset of the §12.1 "System validation / Operations" owner); no finer-grained gate is required for MVP.

## Dependencies

- **Slice 003 — Trip Domain & Status Machine**: the `received → validated` legal edge, the single `transitionTripStatus` service, append-only `trip_events`/`audit_logs`, and the demo seed this slice refreshes.
- **Slice 005 — Control Tower / Trip Detail**: the Trip Detail screen the Validate action is surfaced on.
- **Slice 006 — Dispatch Assignment**: the Dispatch Board queue and the assignment route/error this slice hardens.
- **Slice 007 — Execution Events**: the existing `update_trip_status` permission key the Validate action reuses.

## Out of Scope (Future Enhancements)

- **Automatic validation on import success** — deferred; would require reconciling with the §12.1 Warning-review beat and slice 004's "import does not transition trips" invariant. *(Product decision, backlog.)*
- **Per-customer or rule-driven validation criteria** at validate-time (re-running/extending the §11.2 checks as a transition gate). *(Config-driven, deferred; no §29 input here.)*
- **A dedicated `validate_trip` permission key** or a separate validate endpoint/service. *(YAGNI — reuse `update_trip_status` and the existing transition path.)*
- **Bulk validate** (validating many `received` trips at once). *(Backlog.)*
- **Surfacing a Validate action on the Dispatch Board or Control-Tower row actions** (beyond Trip Detail). *(Backlog; MVP surfaces it on Trip Detail where a `received` trip is inspected.)*

## Blocked / Open for business sign-off

- **None blocking.** No PRD §29 business input gates this slice. One deferred **product** decision is recorded (not blocking): whether `received → validated` should eventually be automatic and/or carry per-customer validation rules — to be decided in the backlog, not built here. *(Constitution II)*
