# Feature Specification: Auto-Validate Imported Trips

**Feature Branch**: `014-auto-validate-imports`

**Created**: 2026-06-07

**Status**: Draft

**Input**: User description: "Auto-validate imported trips (corrective slice 014; references shipped slices 004 trip-import-validation, 006 dispatch/assignment, and 013 predefined-import-template — does NOT edit their shipped specs). Make applied import rows that create a new trip land in `validated` (immediately assignable) instead of `received`, without disturbing existing trips updated by an import; and narrow the dispatch assignment queue to validated-only so it never offers unassignable trips."

## Context & Motivation

Trips imported through the confirm step always land in trip status **`received`** (the import worker
never advances trip status). To be assigned to resources, a trip must first be **`validated`** — the
status machine only allows `received → validated → assigned`. But there is **no operator-facing way to
move a trip from `received` to `validated`**:

- The trip-detail assignment panel only renders for `validated`/`assigned`/`confirmed` trips — a
  `received` trip shows read-only history, no action.
- The execution timeline's milestone buttons are gated to execution statuses
  (`at_origin … completed`) and deliberately exclude `validated`/`validation_error`, so a `received`
  trip offers no next-step button.
- The only path to `received → validated` is a raw status API call (not wired to any button) or a
  direct database edit.

The result is a trap that mirrors the one slice 013 fixed on the import screen, but one step later:
**every imported trip is stranded before dispatch.** It compounds on the dispatch (Expedição) screen,
whose assignment queue lists these unassignable `received` trips with an "Atribuir" action. Clicking it
fails with **"Operação não permitida para o status atual da viagem"** (an `ILLEGAL_TRANSITION`),
because assignment requires the trip to already be `validated`.

The import pipeline (slices 004/013) **already validates every row** — each row gets an outcome of
`valid`, `warning`, or `error`, and only `valid`/`warning` rows are ever applied as trips. A row that
passed import validation *is*, in substance, a validated trip. This slice closes the gap with the
simplest viable answer: **collapse the redundant separate trip-validation step** — applied import rows
that create a new trip land directly in **`validated`**, so imported trips are immediately
dispatch-ready. The dispatch queue is narrowed to validated-only so it never offers an assignment that
cannot succeed.

This is a **corrective behavior change** to the import→dispatch flow. It **references** slices 004
(import pipeline), 006 (dispatch/assignment + queue), 003 (trip status machine + transition/audit
services), and 013 (predefined standard format), and deliberately **reverses** the slices 004/013
behavior that "trips continue to land in `received`". It does **not** edit those shipped specs.

## Clarifications

### Session 2026-06-07

- Q: Should auto-validation apply only to clean (`valid`) rows, or also to `warning` rows? → A: **Both
  `valid` and `warning` applied rows** land their newly created trip in `validated`. Confirm already
  applies both, and warnings are surfaced to and accepted by the operator in the import preview before
  Confirm; treating warnings differently would re-create the exact "stuck in `received` with no UI to
  advance it" trap for warning trips. (May be revisited in `/speckit-clarify`.)
- Q: Does auto-validation ever touch a trip **updated** by an import (match decision `update`, or a
  `new` row re-resolved to an update when it loses the customer/external-id uniqueness race)? → A:
  **No.** Auto-validation applies **only to newly created trips**. An existing trip's status is never
  changed by an import — it may already be `assigned`, `confirmed`, `in_transit`, etc., and must keep
  that status; the import only updates its plan fields.
- Q: How does a newly imported trip enter `validated` — created in `received` then transitioned, or born
  `validated`? → A: **Born `validated` atomically.** Trip creation persists the trip directly in
  `validated` in a single transaction (it is never in `received`), so no worker-crash window between
  creation and validation can strand it; the trip-creation audit records the `validated` initial status.
  There is **no** separate `received → validated` transition or status-change timeline event, and **no**
  raw post-hoc status write. Trip creation gains an optional initial-status parameter (backward-compatible;
  default `received`).
- Q: Are trips already sitting in `received` from imports done **before** this slice backfilled to
  `validated`? → A: **No backfill / no data migration.** Only new imports auto-validate; pre-existing
  `received` trips are left as-is (re-importing them would advance them through the normal path).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Imported trips are immediately dispatch-ready (Priority: P1)

An operator imports a customer trip file and confirms it. The newly created trips appear on the Control
Tower and in the Expedição assignment queue with status **"Validada"**, and the operator can assign
resources to them right away — with no intermediate manual "validate" step.

**Why this priority**: This is the entire point of the slice. Without it, every imported trip is
stranded in `received` with no operator path forward, and the core import→dispatch flow is broken.
Shipping only this story restores a working end-to-end flow from import to assignment.

**Independent Test**: Import and confirm a correctly formatted file, then open Expedição (or the Control
Tower quick-assign) and assign one of the created trips. The assignment succeeds; the trip shows
"Atribuída".

**Acceptance Scenarios**:

1. **Given** a correctly formatted import file, **When** the operator confirms the import, **Then** each
   newly created trip has status **`validated`** ("Validada"), not `received`.
2. **Given** a freshly imported `validated` trip, **When** the operator assigns resources to it on
   Expedição, **Then** the assignment succeeds (`validated → assigned`) with no
   "Operação não permitida para o status atual da viagem" error.
3. **Given** an import containing both `valid` and `warning` rows (e.g. unmapped status label), **When**
   it is confirmed, **Then** the trips created from **both** the valid and warning rows land in
   `validated` and are assignable.

---

### User Story 2 - Updates to in-flight trips never lose their status (Priority: P2)

A later import re-sends a trip that already exists and has progressed (e.g. it is already `assigned` or
`in_transit`). The import updates the trip's plan fields but must **not** revert the trip's status.

**Why this priority**: This is the critical correctness guarantee. Auto-validation must be surgically
limited to trip creation; if an `update` row reset an in-flight trip to `validated`, it would silently
unwind dispatch/execution work — a serious regression. It is P2 only because it protects a less frequent
path than the everyday create-and-assign flow of US1.

**Independent Test**: Create and assign a trip, then import a file whose row matches that trip's
customer + external id with changed plan fields and confirm it. The trip's plan updates but its status
stays `assigned`.

**Acceptance Scenarios**:

1. **Given** an existing trip in `assigned` status, **When** an import `update` row matches it and is
   confirmed, **Then** the trip's plan fields update and its status **remains `assigned`** (it is not
   moved back to `validated`).
2. **Given** a `new` import row that loses the customer/external-id uniqueness race and is re-resolved
   as an update to an existing non-`validated` trip, **When** it is applied, **Then** the existing
   trip's status is **unchanged** (only its plan is updated).
3. **Given** an import `no_op` row matching an existing trip with an identical plan, **When** it is
   confirmed, **Then** no trip is created and no status change occurs.

---

### User Story 3 - The dispatch queue only offers assignable trips (Priority: P3)

A dispatcher opens Expedição and every trip in the assignment queue can actually be assigned — the queue
no longer lists trips whose "Atribuir" action would fail.

**Why this priority**: Removes the remaining confusion (an action that looks available but always
fails). With US1 in place, freshly imported trips are `validated` and would appear regardless, but
narrowing the queue makes the contract explicit and protects against any other non-assignable status
leaking in. Secondary to actually making trips assignable.

**Independent Test**: With a mix of trips across statuses, open Expedição and confirm the queue contains
only unassigned `validated` trips; every "Atribuir" it offers completes successfully.

**Acceptance Scenarios**:

1. **Given** trips in assorted statuses, **When** the dispatcher opens the Expedição assignment queue,
   **Then** only unassigned **`validated`** trips are listed.
2. **Given** the assignment queue, **When** the dispatcher clicks "Atribuir" on any listed trip,
   **Then** the assignment dialog opens and a complete assignment succeeds (no `ILLEGAL_TRANSITION`).
3. **Given** a trip still in `received` (e.g. a leftover from before this slice), **When** the queue is
   shown, **Then** that trip does **not** appear in the assignment queue.

---

### Edge Cases

- **Idempotent re-confirm**: re-running confirmation skips already-applied rows, so it creates no new
  trips, performs no additional status transitions, and does not error on trips already `validated` or
  further along.
- **`potential_duplicate` row**: it had no external-id match, so it creates a NEW trip and is validated
  exactly like a `new` row (its potential-duplicate reason stays recorded on the import row).
- **Uniqueness-race fallback**: a `new` row that hits a duplicate-key violation is re-resolved as an
  update to the existing trip — that existing trip is **not** validated/altered in status (US2 #2).
- **`update` to a trip past confirmation that needs review**: handled exactly as today (the row is
  flagged for review and not applied); no status change occurs.
- **Import with only `error`/unresolved rows**: no trips are created, so there is nothing to validate;
  the batch behaves exactly as in slice 004 (no applied trips).
- **Pre-existing `received` trips** (imported before this slice): not backfilled; they remain
  `received` until re-imported. They also do not appear in the narrowed dispatch queue.
- **`validation_error` trip status**: unreachable via import — error rows are never applied, so no
  applied trip is ever in an error state.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: An applied import row that **creates a new trip** MUST result in that trip being in status
  **`validated`** (immediately assignable), not `received`.
- **FR-002**: Auto-validation MUST apply **only to newly created trips**. An import row that **updates
  an existing trip** — match decision `update`, or a `new` row re-resolved to an update via the
  customer/external-id uniqueness race — MUST NOT change that trip's status; only its plan fields may
  change.
- **FR-003**: Both **`valid`** and **`warning`** applied rows MUST land their newly created trip in
  `validated`. (Confirm already applies both; warnings were surfaced and accepted in the import preview.)
- **FR-004**: A newly created imported trip MUST be created **directly in `validated`** as part of the
  same atomic trip-creation step — it is never first persisted as `received` — so no failure between
  creation and validation can strand it. The trip-creation **audit** MUST record `validated` as the
  initial status; no raw post-hoc status write is introduced. (No separate `received → validated`
  transition or status-change timeline event is produced — the trip is born validated.)
- **FR-005**: Import confirmation MUST remain **idempotent**: re-running it MUST NOT re-transition,
  duplicate, or error on already-applied/validated trips, and MUST NOT disturb trips that have since
  progressed.
- **FR-006**: The dispatch (Expedição) assignment queue MUST list **only unassigned `validated` trips**
  — the trips for which an assignment action will succeed — so it never presents an "Atribuir" action
  that fails for the trip's status. This matches the Control Tower quick-assign gate and the backend's
  validated-only assignment guard.
- **FR-007**: All other import behavior MUST be **unchanged**: per-row validation outcomes and reason
  codes, duplicate detection and match decisions, which rows are applied (`valid`/`warning`) vs skipped
  (`error`/unresolved), the error report, import history, and the import-batch status lifecycle.
- **FR-008**: This slice MUST add **nothing durable**: no new table, column, enum value, migration,
  permission, package, worker job, or runtime dependency. It reuses the existing `validated` trip-status
  value and the existing trip-creation + audit services (extended only with a backward-compatible
  initial-status parameter), plus the existing dispatch-queue status filter.
- **FR-009**: The **auto-validate-on-import policy** MUST be recorded as a labeled decision — the
  trip-level validation gate (PRD §11) is satisfied by import-time per-row validation, so imported trips
  skip a separate manual validation step — so a future reviewer understands why imported trips are
  created `validated` rather than `received`.

### Key Entities *(include if feature involves data)*

- **Trip status** (existing, unchanged enum): the relevant edge is `received` (imported, awaiting
  validation) → `validated` (data complete, assignable) → `assigned`. This slice changes only **where in
  the pipeline a created trip enters the machine** — imports now produce `validated` directly for newly
  created trips, instead of `received`.
- **Import row match decision** (existing): `new`/`potential_duplicate` → **create** a trip
  (auto-validated by this slice); `update` → **modify** an existing trip (status untouched); `no_op` →
  skip; `error`/unresolved → not applied.
- **Dispatch assignment queue** (existing): the unassigned-by-pickup work list shown on Expedição; this
  slice constrains it to unassigned `validated` trips.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After confirming a correctly formatted import, **100%** of the newly created trips show
  status "Validada" and require **zero** additional steps before they can be assigned.
- **SC-002**: Assigning a freshly imported trip from Expedição (or via Control Tower quick-assign)
  **succeeds**, with no "Operação não permitida para o status atual da viagem" error.
- **SC-003**: **0%** of in-flight trips (already `assigned` or further) are reverted to `validated` by an
  import update — an `update` row leaves the existing trip's status unchanged.
- **SC-004**: Re-running an import confirmation produces **zero** additional status transitions, **zero**
  duplicate trips, and **zero** errors.
- **SC-005**: The Expedição assignment queue contains **only** assignable (unassigned `validated`) trips
  — **zero** trips for which an assignment action would fail.
- **SC-006**: **No regression**: for the same input file, the rows applied vs skipped, the per-row
  reasons, duplicate detection, and confirmation results are identical to slices 004/013 (the only
  observable change is the created trips' status).

## Assumptions

- Import-time per-row validation (`valid`/`warning`/`error`) is an adequate substitute for a separate
  manual trip-validation step; a row that passes import validation is treated as a validated trip
  (operator-confirmed direction, this session).
- Both `valid` and `warning` applied rows are validated (warnings were already reviewed in the preview).
- Only **new** trips are auto-validated; trips touched by an `update` retain their status.
- Trips already in `received` from imports performed **before** this slice are **not** migrated or
  backfilled (no data migration).
- The `validated` trip-status value already exists and is reused; imported trips are **born `validated`**
  by extending trip creation with an optional initial-status parameter (backward-compatible; default
  `received`), rather than by a post-creation transition. The `received → validated` status-machine edge
  is unchanged and remains available for any non-import path.
- The dispatch board read query already supports an explicit status filter that suppresses the
  active-scope default, so narrowing the queue is a query-parameter change, not new read logic.
- The slices 004/013 import pipeline (mapping, validation, duplicate detection, confirmation, error
  report, history) and the slice 006 assignment services are in place and are **reused** without
  redefinition.

## Out of Scope *(Future)*

- A manual **"Validar" operator action/button**, or any other UI to move a trip `received → validated`.
  Auto-validation removes the need for imports; no manual control is added for other paths.
- **Backfilling** existing `received` trips to `validated` (no data migration).
- Reaching the **`validation_error`** trip status via import (error rows are never applied, so no applied
  trip is ever in error).
- Any change to per-row validation logic, reason codes, duplicate detection, confirmation, status
  mapping, or import history.
- Surfacing import **batch-failure reasons on the history screen** (still a separate follow-up, per
  slice 013).

## Dependencies & References

- **Builds on slice 004** (trip import & validation): reuses the import confirm pipeline and match
  decisions; **reverses** its "trips land in `received`" behavior for created trips. References 004;
  does not edit its shipped spec.
- **Builds on slice 013** (predefined import template): the standard-format import path whose confirmed
  trips this slice now lands in `validated` instead of `received`.
- **Builds on slice 006** (dispatch & assignment): reuses the assignment services and the dispatch
  assignment queue, which this slice narrows to validated-only.
- **Builds on slice 003** (trip domain & lifecycle): reuses the trip-creation and audit services
  (extending trip creation with an optional initial status) and the `validated` status value; the
  `received → validated` status-machine edge itself is unchanged and is not used by the import path.
- **PRD §11** (Import & Trip Validation workflows) and the trip **status machine**: the auto-validate
  policy is recorded as a labeled decision against these.
- **Constitution**: reuse promoted services (never re-implement the status machine, trip creation, or
  audit); one config-driven import engine; corrective work ships as a **new referencing slice**, not an
  edit to a shipped spec.
