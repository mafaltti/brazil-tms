# Feature Specification: Validation-Error Reject Action

**Feature Branch**: `010-trip-validation-dispatch-fix` (folded into PR #13 — see Slice ownership)

**Created**: 2026-06-02

**Status**: Draft

**Input**: User description: "Add the reject action — complete the validate/reject pair. Slice 010 shipped the `validation_error → received` correction but nothing moves a trip INTO `validation_error`. Add a gated operator action on Trip Detail that performs `received → validation_error` with a required reason, mirroring Validar viagem. Reuse the existing status endpoint / permission / notes field — add nothing durable."

**Source PRD sections**: §11.2 (Trip Validation Workflow — the "Error: trip cannot proceed until corrected" outcome), §12 / §12.1 (Trip Status Lifecycle — the `received ↔ validation_error` edges), §18 / §21.4 (Permissions / least privilege), §21.5 (Auditability)

**Primary requirement IDs**: TRIP-006, TRIP-007 (003 — status machine). Completes the validate/reject pair begun in **slice 010**; relates to **GitHub issue #11**.

**Slice ownership**: A **micro corrective slice** that completes the asymmetry slice 010 created: 010 shipped the **correction** `validation_error → received` (and the forward `received → validated`) but **no path moves a trip INTO `validation_error`** — so the shipped correction was unreachable in practice (import handles bad rows at the batch level and never sets the trip status). This slice adds the missing **reject** transition `received → validation_error` as a deliberate operator action, **"Marcar erro de validação"**, surfaced on the **Trip Detail** screen alongside slice 010's "Validar viagem" (it **extends the same `ValidateAction` component**). It **adds NOTHING durable**: NO new table, enum, migration, permission key, package, dependency, worker, **endpoint, or service**. The reject reuses the **existing** `POST /api/trips/:id/status` endpoint via the existing `useRecordMilestone` hook; the legal edge `received → validation_error` already exists (`trip-status.ts:85`); the reject **reason** is carried by the **existing** optional `notes` field of `transitionTripSchema`, which `transitionTripStatus` **already persists atomically** on the append-only `trip_events` `status_change` row (`trip-transitions.ts:85`) and audits. Authorization reuses **`update_trip_status`** (Admin, Operations Manager, Dispatcher, Control Tower) — the same key as Validar. Because it lands on slice 010's not-yet-merged Trip Detail surface and is tightly coupled to it, the code is **folded into PR #13** (the `010-trip-validation-dispatch-fix` branch); it is tracked as slice 011 for traceability. Builds on `specs/010-trip-validation-dispatch-fix/` and `specs/003-trip-domain-lifecycle/` (the status machine + `transitionTripStatus`). **Not in scope:** an automatic import-time validator that auto-sets `validated`/`validation_error` (contradicts the decided 004 "import does not transition trips" + 010 "no auto-validate" design — deferred), and server-enforced reason (the reason is client-required; `notes` stays optional at the schema level).

## Clarifications

### Session 2026-06-02

- Q: Does the reject need a new endpoint / service / schema field for the reason? → A: **No.** `transitionTripSchema` already has an optional `notes` field that `transitionTripStatus` persists on the `trip_events` `status_change` row, atomically and audited. The reject reuses it. No durable change.
- Q: Is the reason required? → A: **Client-required** (the reject button is disabled until a reason is typed). The schema `notes` stays **optional** (server-side), so a reject without a reason is not a server error — enforcing it server-side would touch slice-003 shared code and is out of scope for this micro-slice.
- Q: New permission for reject? → A: **No.** Reuses **`update_trip_status`** (same as Validar) — holders Admin / Operations Manager / Dispatcher / Control Tower. The action is hidden for non-holders and the BFF re-enforces.
- Q: Automatic validation at import? → A: **Out of scope / deferred** — contradicts the decided 004/010 design (import does not transition; no auto-validate). `validation_error` stays an operator-driven flag.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Reject a received trip whose data is wrong (Priority: P1)

An operator reviewing a **`received`** trip on Trip Detail finds its data is not execution-ready (e.g. an unrecognized destination or an invalid delivery window). Instead of validating it, the operator clicks **"Marcar erro de validação"**, types a **reason**, and the trip moves to **`validation_error`** — recorded in history with the reason. The trip is now clearly flagged "reviewed and rejected" (distinct from "not yet reviewed") and does not appear in the dispatch queue. After the data is corrected, the operator returns it to `received` (the slice-010 correction) and validates it.

**Why this priority**: It completes the validate/reject/correct triangle; without it slice 010's correction is unreachable and §11.2's "Error" outcome has no operator action.

**Independent Test**: As an `update_trip_status` holder, on a `received` trip, supply a reason and reject → assert the trip is `validation_error`, exactly one append-only `status_change` event carries the reason in `notes` and an audit row exists; the reject button is disabled without a reason; a non-holder cannot see/use it; the action is not offered for a non-`received` trip.

**Acceptance Scenarios**:

1. **Given** a `received` trip and a permitted operator who types a reason, **When** they activate "Marcar erro de validação", **Then** the trip becomes `validation_error`, with the reason persisted on the append-only `status_change` event and an audit record. *(§11.2, §21.5)*
2. **Given** the reject control with an empty reason, **When** the operator looks at it, **Then** the reject button is disabled (reason required). *(client-required)*
3. **Given** a `validation_error` trip, **When** the data is corrected, **Then** the operator returns it to `received` (slice-010 correction) and can validate it. *(§12.1)*
4. **Given** a non-holder of `update_trip_status`, **When** they view the trip, **Then** the reject action is not available and a direct attempt is refused. *(§18, §21.4)*

### Edge Cases

- **Stale submit**: rejecting a trip whose status already changed fails cleanly with `STALE_TRANSITION` (the existing optimistic-concurrency guard), no double-apply.
- **Empty reason via direct API**: the schema keeps `notes` optional, so an API caller could reject without a reason; this is accepted (the reason is a UX requirement, not a server rule). Documented, not enforced.

## Requirements *(mandatory)*

- **FR-001**: The system MUST provide an operator action on Trip Detail that transitions a `received` trip to `validation_error`, available only when the trip is `received`. *(§11.2, §12.1)*
- **FR-002**: The reject action MUST capture a **reason** (client-required) and persist it on the append-only `status_change` event via the existing `notes` field — atomically with the transition. *(§21.5)*
- **FR-003**: The action MUST be authorized by the existing **`update_trip_status`** permission, hidden for non-holders, and re-enforced by the BFF. **No new permission key.** *(§18, §21.4)*
- **FR-004**: The transition MUST flow through the existing single status-transition service / endpoint (`transitionTripStatus` via `POST /status`) — NO new endpoint, service, write path, or status-machine change. *(Constitution III)*
- **FR-005**: The slice MUST add **no** new table, enum, migration, permission key, package, dependency, or worker. *(Constitution I)*
- **FR-006** *(non-requirement)*: The system MUST NOT auto-set `validation_error` at import in this slice (deferred). *(Constitution I/II)*

## Success Criteria *(mandatory)*

- **SC-001**: An operator can move a `received` trip to `validation_error` from the UI, with the reason visible in history; the trip then does not appear in the dispatch queue and the slice-010 correction returns it to `received`. *(completes the pair)*
- **SC-002**: Every reject produces exactly one append-only `status_change` event (with the reason in `notes`, source `operator_manual`, attributable actor) and one audit record. *(§21.5)*
- **SC-003**: A non-holder of `update_trip_status` can neither see nor perform the reject. *(§21.4)*
- **SC-004**: The change introduces no new permission key, table, enum, migration, dependency, package, or worker (verifiable by diff). *(Constitution I)*

## Assumptions

- Slice 010's `ValidateAction` component + the threaded `viewerRole` are present (this slice extends them); the code lands on the same branch/PR.
- The reason is a UX requirement (client-required); server-side `notes` stays optional.
- pt-BR only (no `en` catalog).

## Dependencies

- **Slice 010** — the `ValidateAction` component + Trip Detail wiring this slice extends.
- **Slice 003** — the `received → validation_error` legal edge, `transitionTripStatus`, the `notes` field on `trip_events`, append-only audit.

## Out of Scope (Future)

- Automatic import-time validator (auto-setting `validated`/`validation_error` from the §11.2 checks).
- Server-enforced reject reason (would touch slice-003 shared schema/service).

## Blocked / Open for business sign-off

- **None.** No PRD §29 input gates this slice.
