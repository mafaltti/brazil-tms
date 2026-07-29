# Feature Specification: Dispatch Assignment and Conflict Warnings

**Feature Branch**: `006-dispatch-assignment`

**Created**: 2026-05-31

**Status**: Draft

**Input**: User description: "006 — Dispatch Assignment And Conflict Warnings. Dispatchers can assign resources (driver, vehicle, trailer, carrier) to trips and see conflict or eligibility warnings. Screens: Dispatch Board, assignment panel in Trip Detail, assignment actions from Control Tower where appropriate. Data entity: Trip Assignment. Rules: a trip has at most one current assignment; reassignment supersedes the previous assignment and retains history; assignment checks resource schedule conflicts, vehicle type compatibility, inactive/blocked resources, missing/expired documentation, and carrier approval; authorized users may override warnings with a reason; assignment notes and a confirmation timestamp are captured. Owned-fleet vs subcontracted split affects assignment policy; blocking vs warning behavior may start with company defaults unless customer policy is provided. Out of scope: resource recommendation, execution events, SLA risk engine, billing. Conflict checks must be enforced in the BFF/domain layer, not only in the UI; keep the assignment flow fast for daily dispatcher work. Do not invent missing customer, SLA, document, or billing details — make behavior configurable and mark final sign-off blocked when inputs are unavailable."

**Source PRD sections**: §11.3, §13.5, §14.1, §15.6, §16, §19.2, §22 (Phase 3), §23

**Primary requirement IDs**: DISP-001, DISP-002, DISP-003, DISP-004, DISP-005, DISP-006, DISP-007, DISP-008, DISP-009

**Slice ownership**: `docs/SPEC-SLICING.md` slice 006 — owns the **dispatch/assignment write surface** over the trip domain: the **Dispatch Board**, the **assignment panel** that fills slice 005's Trip-Detail placeholder, the assignment **filters / "Unassigned" view / row indicator / dashboard count** that slice 005 left for 006 to deliver, and the single new **Trip Assignment** entity. It **reuses, never redefines**: the platform/auth/audit/i18n primitives and the pre-declared `assign_resources` permission key from slice 001; the **fleet master data** (Driver, Vehicle, Trailer, Carrier and their status / type / document-expiry semantics) from slice 002; and the **trip model, 18-state status machine, transition service, and audit semantics** from slice 003 — assignment is the `validated → assigned` (and `assigned → confirmed`) transition, driven through 003's existing transition service, not a redefinition of it. Resource recommendation (DISP-010) is Later; execution events, exceptions, and SLA risk are slice 007; documents and billing are slice 008.

---

## Overview & Intent *(why this feature exists)*

Slice 005 gave Brazil Transports the **operating board** — see, search, filter, and inspect every trip — but it is deliberately read-first: it shows an empty **assignment placeholder** on Trip Detail and leaves the "Unassigned" view, the assignment filters, and the assignment row indicator as framework slots for a later slice to fill. **This slice is that slice.** It is where the operation stops looking at trips and starts **dispatching** them: a dispatcher takes a planned, validated trip and **assigns the resources that will actually run it** — a driver, a vehicle, a trailer where applicable, and a carrier/subcontractor where the work is outsourced — and the system tells them, *before they commit*, whether that combination is safe to dispatch.

The value is in the **warnings**. Picking a driver from a dropdown is trivial; knowing that the driver is already on an overlapping trip, that the vehicle is in maintenance, that the truck's documents expired last week, that the vehicle type does not match what the customer planned, or that the carrier is not approved for this customer/lane — *that* is what prevents a failed pickup. Per PRD §19.2 and STACK §6.1, that conflict and eligibility judgement is **authoritative in the BFF/domain layer, never owned by the UI**: the client renders the warnings, but it cannot bypass them, and it cannot decide what is allowed.

This slice is a **focused write surface** layered onto 005's read shell. It introduces exactly **one new table** — `trip_assignments`, the Trip Assignment entity PRD §14.1 defines and SPEC-SLICING assigns to 006 — and **no new enum, permission key, package, or worker**. Authorization reuses the `assign_resources` key already declared (but never enforced) in the 001 catalog; **006 enforces it for the first time**, exactly as 005 first-enforced `view_all_trips`. The status changes assignment causes (`validated → assigned`, `assigned → confirmed`, `assigned → validated` on un-assign) are driven through slice 003's existing transition service and audit semantics — 006 records *which resources* were assigned, by whom, with what notes and override reasons, but it does not redefine the state machine, the audit log, or the master-data model.

Two policy questions sit on top of this and are deliberately **configurable, not invented**: the **owned-fleet vs subcontracted split** (PRD §29 Input #6) shapes *which* resources a trip requires, and the **blocking-vs-warning behaviour** (PRD §19.2: "configurable by customer and company policy") decides which conflicts hard-stop an assignment versus which a permitted user may override with a reason. This slice ships sensible, documented **company defaults** for both and marks final business sign-off **blocked** until Input #6 and customer policy arrive — it never fabricates customer, document, or carrier-approval data to fill the gap.

---

## Clarifications

### Session 2026-05-31 *(design decisions resolved while specifying; informed defaults — business-input gaps are recorded under "Blocked / Open for business sign-off")*

- Q: Which roles may assign resources? → A: The **existing `assign_resources` key** from the 001 catalog — already declared and granted to **Admin, Operations Manager, Dispatcher, Fleet Coordinator** but **never enforced**. Slice 006 is the **first slice to enforce `assign_resources`** (no new key, no DB permissions table — Constitution V), mirroring how 005 first-enforced `view_all_trips`. Control Tower, Finance, and Executive Viewer are **not** granted it and may view assignments (via 005) but not create them.
- Q: Does 006 add new schema? → A: Exactly **one new table** — `trip_assignments` (the PRD §14.1 Trip Assignment entity that SPEC-SLICING assigns to 006), justified as the core entity of the slice. **No new enum** (reuses 002's `resource_status`, `vehicle_type`, `trailer_type`, `ownership_type` and 003's `trip_status`), **no new permission key, no new package, no new worker.**
- Q: How does assignment relate to the status machine? → A: Assignment **drives**, never redefines, slice 003's machine: making the first assignment fires `validated → assigned`; confirming the trip fires `assigned → confirmed`; removing all resources (un-assign) fires `assigned → validated`. Each runs through 003's existing transition service (with its optimistic-concurrency guard and audit write). **Reassignment/substitution supersedes the current assignment record and retains history; it does not by itself change the trip status** (a driver swap on an `assigned` or `confirmed` trip leaves the status unchanged).
- Q: At most one current assignment — how enforced? → A: Each trip has **at most one current assignment** (`is_current = true`), enforced server-side by a uniqueness guarantee on `(trip_id) WHERE is_current`. Reassignment marks the prior row superseded (`is_current = false` + superseded-by/at) and inserts a new current row in one transaction; **superseded assignments are never deleted** (Constitution III — auditable history).
- Q: Which conflict/eligibility checks run at assignment time? → A: The authoritative PRD §19.2 set — (1) **schedule conflict**: driver / vehicle / trailer already on an overlapping current assignment; (2) **resource status**: driver inactive or blocked, vehicle inactive / maintenance / blocked, trailer inactive / blocked; (3) **vehicle-type compatibility** vs the trip's planned vehicle type; (4) **carrier active/approved**; (5) **documentation expired or missing** for driver, vehicle, trailer, carrier. All evaluated **server-side in the BFF/domain layer** (STACK §6.1 — the UI must not own assignment-conflict authority).
- Q: Blocking vs warning behaviour? → A: Each check has a **severity = BLOCK or WARN**, resolved by **company default first, customer policy override second** (PRD §19.2; config-driven per Constitution V — never per-customer code). A **WARN** lets an authorized user proceed by supplying an override **reason**; a **BLOCK** hard-stops the assignment. The **company-default severity table is confirmed** (see the block-vs-warn clarification below and Assumptions); only **per-customer overrides** remain configuration — no values invented.
- Q: Override (DISP-008)? → A: A user with assignment permission may **override any WARN-severity conflict by supplying a required free-text reason**; the reason is persisted on the assignment record and **audited**. An empty reason refuses the override. **BLOCK-severity conflicts are not overridable by any role** (resolved in the override-authority clarification below). Override authority = **`assign_resources` holders**; **no new permission key is invented**.
- Q: Owned-fleet vs subcontracted applicability (DISP-003/004 "where applicable")? → A: Resource ownership comes from 002's `ownership_type` (`owned` / `subcontracted`). All four resource kinds are assignable and **trailer is optional**; the **minimum-required set to assign is confirmed below** (driver + vehicle always; carrier additionally when subcontracted). The broader owned-vs-subcontracted policy (mixing owned + subcontracted, per-ownership nuances) follows PRD §29 Input #6.
- Q: Where does carrier-approval data come from (DISP-004; §19.2 "carrier not approved for customer or lane")? → A: Slice 002 **explicitly deferred** `approved_customers` / `approved_lanes` to feature 006 and did not store them; the **approval scope** (per-customer vs per-lane, ownership, management) is undefined business input. **Resolved (see the carrier-approval clarification below): the approved-for-customer/lane rule is out of MVP scope** — 006 builds no approval storage and enforces only carrier eligibility that exists (`contract_status`, `documentation_status`, not-archived/active). No approval data is invented.
- Q: Vehicle-type compatibility (DISP-006)? → A: **MVP default = exact match** of the vehicle's `vehicle_type` to the trip's `planned_vehicle_type`. A richer **substitution/compatibility matrix** (e.g., a larger type satisfying a smaller requirement) is config-driven future work (YAGNI) and not built now.
- Q: Schedule-overlap definition (DISP-005)? → A: A resource (driver/vehicle/trailer) conflicts if it appears on **another current assignment** whose trip's **planned pickup→delivery window intersects** this trip's planned window, excluding `cancelled` and other terminal trips. **MVP default turnaround buffer = 0 minutes**, configurable by Ops.
- Q: Which documents does the expiry/missing check read (DISP-007)? → A: The **resource master-data document fields from 002** — driver `license_expiry`, vehicle/trailer `document_expiry`, carrier `documentation_status` — plus 002's **30-day expiry-warning window** (`DOCUMENT_EXPIRY_WARNING_DAYS`). "Expired" = past expiry; "expiring" (within 30 days) is a WARN-level heads-up; "missing" = no expiry/doc on file. This is **not** the per-customer trip **proof-document checklist**, which is owned by slice 008.
- Q: How is the Dispatch Board kept fresh? → A: **Polling via TanStack Query** (no Realtime, no Edge Functions — STACK §3.10), reusing 005's per-surface cadence config; **Dispatch Board default 30s**. Resource availability and conflict state reflect the latest poll.
- Q: Where can a user assign? → A: Three entry points onto **one** assignment service — (1) the **assignment panel in Trip Detail** (fills slice 005's FR-014 placeholder), (2) the new **Dispatch Board** (the high-volume daily workspace, §15.6), and (3) **quick assignment actions from the Control Tower** where appropriate. 006 also **delivers into 005's shell** the assigned-driver/vehicle/carrier **filters**, the **"Unassigned" default view**, the **assignment row indicator**, and the **"unassigned trips" dashboard count** that 005 framed but left empty.
- Q: Carrier approval — what should 006 build for the "approved for customer/lane" check (slice 002 deferred the data)? → A: **Defer the approval storage; carrier eligibility only.** 006 builds **no** carrier↔customer/lane approval schema; carrier eligibility = `active`/not-archived + `contract_status` + `documentation_status`. The **approved-for-customer/lane rule is out of MVP scope** and is revisited only when its scope (per-customer vs per-lane, ownership, management) is defined — no approval data is invented. Keeps 006 to its single new table.
- Q: Block-vs-warn — which company-default severity does 006 build and test against (§19.2)? → A: **The documented default table.** **BLOCK**: resource `blocked`/`inactive`, vehicle `maintenance`, **expired** documentation, carrier not-active/contract-expired. **WARN** (overridable with reason): schedule overlap, vehicle-type mismatch, **missing** documentation, expiring-soon (≤30 days). Per-customer overrides remain **configuration** (Constitution V); this table is the build/test target, not a blocked item.
- Q: Minimum resources to move `validated → assigned` (company default; §29 Input #6)? → A: **Driver and vehicle are always required; a carrier is additionally required when the assigned resources are subcontracted (i.e. the chosen driver/vehicle carry 002's `ownership_type = subcontracted`); trailer optional.** Trips have no `ownership_type` field — "subcontracted" is derived per-resource from the assigned driver/vehicle. A subcontracted assignment therefore records the carrier **and** its driver/vehicle up front. The minimum set is **configuration**; the broader ownership policy (mixed-ownership trips, per-ownership nuances) stays open (§29 Input #6).
- Q: When may a dispatcher confirm a trip (`assigned → confirmed`)? → A: **Confirmation re-runs the eligibility/conflict checks and is refused if any unresolved BLOCK is present**; it is allowed when only WARN-level findings remain (those were already overridden at assignment). This catches resource **drift** between assignment and confirmation (e.g., a license that expired in the interim) without adding a separate readiness checklist.
- Q: Override authority — who may override, and can a BLOCK ever be overridden (DISP-008)? → A: **Any `assign_resources` holder may override a WARN with a required reason; a BLOCK is an absolute hard-stop that no role can override.** This uses only the **existing** permission key (no new key — Constitution V) and keeps BLOCK a genuine safety/compliance stop. A future senior BLOCK-override, if ever needed, is a deliberate permission-catalog change, not scaffolded now.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Assign and confirm the resources that will run a trip (Priority: P1)

A dispatcher opens a validated trip's **assignment panel** (on Trip Detail or the Dispatch Board) and chooses the resources to run it: a driver, a vehicle, a trailer where applicable, and — when the work is subcontracted — a carrier. As they pick, the system evaluates the combination and shows **inline eligibility/conflict warnings** (covered in depth by US2). When the combination is acceptable (or warnings are overridden — US3), they save: the trip moves from `validated` to `assigned`, the assignment is recorded with **who assigned it, when, and any notes**, and exactly **one current assignment** now exists for the trip. When operational readiness is complete, the dispatcher **confirms** the trip, capturing the **confirmation timestamp** and moving it to `confirmed`.

**Why this priority**: This is the reason the slice exists and the §23 MVP acceptance line — "Dispatch can assign resources and confirm trips." It is independently viable: with only this story, the operation can dispatch every trip from the system. Every other story refines or surfaces it. *(DISP-001, DISP-002, DISP-003, DISP-004, DISP-009, §11.3, §14.1, §23)*

**Independent Test**: With validated trips and active fleet master data present (from 002/003), open a trip's assignment panel; assign a driver, a vehicle, a trailer, and (for a subcontracted trip) a carrier; save and verify the trip status becomes `assigned`, the assignment shows assigned-by + assigned-at + notes, and the trip now has exactly one current assignment; confirm the trip and verify the status becomes `confirmed` with a confirmation timestamp recorded; verify the assignment, confirmation, and any change appear in the trip's audit history.

**Acceptance Scenarios**:

1. **Given** a `validated` trip and an authorized dispatcher, **When** they assign a **driver**, **Then** the driver is recorded on the trip's current assignment. *(DISP-001, §11.3)*
2. **Given** the assignment panel, **When** the dispatcher assigns a **vehicle**, **Then** the vehicle is recorded on the current assignment. *(DISP-002)*
3. **Given** a trip that uses a trailer, **When** the dispatcher assigns a **trailer**, **Then** the trailer is recorded; trailer assignment is optional where not applicable. *(DISP-003)*
4. **Given** a subcontracted trip, **When** the dispatcher assigns a **carrier/subcontractor**, **Then** the carrier is recorded on the current assignment. *(DISP-004)*
5. **Given** a clean (no-blocking-conflict) assignment, **When** the dispatcher saves, **Then** the trip transitions `validated → assigned` via slice 003's transition service and the assignment captures **assigned-by, assigned-at, and notes**. *(DISP-009, §11.3, §14.1; reuses 003)*
6. **Given** an `assigned` trip with no unresolved BLOCK finding, **When** the dispatcher confirms it, **Then** the checks are **re-run**, the trip transitions `assigned → confirmed`, and a **confirmation timestamp** (and confirming user) is captured; if a BLOCK has arisen since assignment (resource drift), confirmation is refused. *(DISP-009, §11.3 step 8, §23)*
7. **Given** any of the above actions, **When** it succeeds, **Then** it is recorded in the trip's audit history (assignment / confirmation), reusing 003's audit semantics. *(§14.1, §21.5; reuses 003)*

---

### User Story 2 - See conflict and eligibility warnings before committing (Priority: P1)

Before the dispatcher commits an assignment, the system checks the chosen resources and surfaces **inline warnings** for every problem in PRD §19.2: a driver/vehicle/trailer already booked on an overlapping trip, an inactive/blocked/maintenance resource, a vehicle type that does not match the customer's planned type, a carrier that is not active/approved, and documentation that is expired or missing. Each problem is shown with its **severity** — a **blocking** problem prevents the assignment outright; a **warning** can be overridden by a permitted user (US3). The judgement is made **server-side** and cannot be bypassed by the client.

**Why this priority**: The warnings are the differentiating value of the feature (§15.6, §19.2) and the §16 promise of "inline warnings for conflicts and missing data." Without them, US1 is just a dropdown. It is P1 and tested alongside US1. *(DISP-005, DISP-006, DISP-007, §19.2, §15.6)*

**Independent Test**: Construct each conflict in turn and verify the matching warning surfaces with the correct severity, and that a BLOCK-severity conflict prevents saving while a WARN-severity conflict is allowed only via override: (a) assign a driver already on a time-overlapping current assignment → schedule-conflict; (b) assign a vehicle with status `maintenance`/`blocked` → resource-status; (c) assign a vehicle whose type ≠ the trip's planned vehicle type → type-mismatch; (d) assign a carrier with `contract_status = expired`/archived → carrier-not-active; (e) assign a driver whose `license_expiry` is past / a vehicle whose `document_expiry` is missing → documentation. Repeat one check **server-side with the UI bypassed** (direct API call) and verify the server still refuses/flags it.

**Acceptance Scenarios**:

1. **Given** a resource already on an overlapping current assignment, **When** it is selected, **Then** a **schedule-conflict** warning is raised for that driver/vehicle/trailer. *(DISP-005, §19.2)*
2. **Given** a driver that is inactive/blocked, a vehicle that is inactive/maintenance/blocked, or a trailer that is inactive/blocked, **When** it is selected, **Then** a **resource-status** warning is raised. *(DISP-005, §19.2)*
3. **Given** a vehicle whose type does not match the trip's planned vehicle type, **When** it is selected, **Then** a **vehicle-type-compatibility** warning is raised. *(DISP-006, §19.2)*
4. **Given** a carrier that is not eligible (expired or suspended contract, archived, or expired documentation), **When** it is selected, **Then** a **carrier-eligibility** warning is raised; the approved-for-customer/lane rule is out of MVP scope (see Clarifications). *(DISP-004, DISP-005, §19.2)*
5. **Given** a resource with documentation that is expired or missing, **When** it is selected, **Then** an **expired/missing-documentation** warning is raised (with an "expiring soon" heads-up inside the 30-day window). *(DISP-007, §19.2)*
6. **Given** any check whose configured severity is **BLOCK**, **When** the dispatcher tries to save, **Then** the assignment is refused; **Given** a **WARN**, saving requires an override reason (US3). *(§19.2 — configurable block/warn)*
7. **Given** the UI is bypassed, **When** an assignment is posted directly to the BFF, **Then** the same checks run server-side and the same block/warn outcome is enforced (the UI does not own conflict authority). *(STACK §6.1, §6.2)*

---

### User Story 3 - Override a warning with a recorded reason (Priority: P2)

A dispatcher knows something the system does not — the "overlapping" trip was cancelled verbally, the missing document is on its way — and needs to proceed despite a **warning**. If they have permission, they enter a **reason** and complete the assignment; the reason is stored on the assignment and written to audit history so the override is accountable. A user without override permission, or an empty reason, cannot proceed past the warning, and no one can override a **blocking** conflict.

**Why this priority**: Operations cannot run if every warning is a hard wall, but override is a refinement on top of US1/US2 and carries accountability weight, so it is P2. *(DISP-008, §11.3 step 6)*

**Independent Test**: As an authorized user, trigger a WARN-severity conflict, attempt to save without a reason and verify it is refused, then supply a reason and verify the assignment completes with the reason persisted and visible in audit history; as a user without override authority, verify the override is refused server-side; attempt to override a BLOCK-severity conflict and verify it cannot be overridden.

**Acceptance Scenarios**:

1. **Given** a WARN-severity conflict and an authorized user, **When** they supply an override **reason** and save, **Then** the assignment completes and the reason is stored on the assignment record. *(DISP-008, §14.1)*
2. **Given** an override, **When** it is saved, **Then** the override (with its reason and acting user) is recorded in audit history. *(DISP-008, §21.5; reuses 003 audit)*
3. **Given** a WARN-severity conflict, **When** the user attempts to save with **no reason**, **Then** the override is refused. *(DISP-008)*
4. **Given** a user without override authority, **When** they attempt to override a warning, **Then** the action is refused **server-side**, regardless of the client state. *(DISP-008, STACK §5.2/§6.1)*
5. **Given** a BLOCK-severity conflict, **When** any user attempts to override, **Then** the assignment remains refused (BLOCK is not overridable by any role). *(§19.2; resolved — see Clarifications)*

---

### User Story 4 - Reassign / substitute resources, retaining full history (Priority: P2)

Plans change — a driver calls in sick, a truck breaks down. A dispatcher opens an already-assigned (or confirmed) trip and **substitutes** one or more resources. The new assignment becomes the trip's single **current** assignment; the previous one is **superseded and retained** as history, so the trip's assignment record shows the full chain of who was assigned when and why each changed. The same eligibility/conflict checks (US2) and override rules (US3) apply to the new resources.

**Why this priority**: Substitution is core to real dispatch (PRD §14.1 cardinality decision) but builds directly on US1; it is P2. *(DISP-001–DISP-005, §14.1 cardinality)*

**Independent Test**: Assign a trip, then reassign a different driver/vehicle; verify the trip still has **exactly one** current assignment pointing to the new resources, the prior assignment is retained and retrievable as history (marked superseded, with timestamp), the trip status is unchanged by the substitution, and the eligibility checks re-ran for the new resources.

**Acceptance Scenarios**:

1. **Given** a trip with a current assignment, **When** the dispatcher reassigns a different resource, **Then** a new current assignment is created and the trip has **at most one** current assignment. *(§14.1 cardinality)*
2. **Given** a reassignment, **When** it is saved, **Then** the **previous assignment is superseded and retained** (not deleted), with its superseded-by/superseded-at recorded. *(§14.1; Constitution III — no hard delete of auditable history)*
3. **Given** a reassignment on an `assigned` or `confirmed` trip, **When** it is saved, **Then** the trip **status is unchanged** by the substitution. *(§14.1; status machine has no confirmed→assigned transition)*
4. **Given** a reassignment, **When** the new resources are chosen, **Then** the full eligibility/conflict checks (US2) and override rules (US3) apply to them. *(DISP-005–DISP-008)*
5. **Given** an authorized user, **When** they **un-assign** a trip (remove resources entirely), **Then** the trip transitions `assigned → validated` via 003's transition service and the prior assignment is retained as history. *(§14.1; reuses 003)*

---

### User Story 5 - Work the Dispatch Board and surface assignment across the operating board (Priority: P2)

A dispatcher opens the **Dispatch Board** — their daily workspace — and sees **unassigned trips ordered by pickup time**, the **availability** of resources, and **conflict warnings** in context, so they can assign and confirm with minimal clicks (§16). Beyond the dedicated board, the assignment data 006 produces now lights up the slots slice 005 left for it: the **assigned-driver / assigned-vehicle / carrier filters** and the **"Unassigned" view** in the Control Tower, the **assignment row indicator**, and the **"unassigned trips" count** on the Home Dashboard.

**Why this priority**: The board is the high-volume surface §15.6 mandates and the integration that makes assignment visible operation-wide, but the underlying capability (US1–US4) must exist first, so it is P2. *(§15.6, §16; fills slice 005 FR-003b/FR-006/FR-007/FR-029 placeholders)*

**Independent Test**: Open the Dispatch Board and verify it lists unassigned trips ordered by pickup time, shows resource availability and inline conflict warnings, and lets a dispatcher assign and confirm from it; then in the Control Tower verify the assigned-driver/vehicle/carrier filters narrow the list, the "Unassigned" view shows only unassigned trips, the assignment row indicator reflects assignment state, and the Home Dashboard "unassigned trips" widget shows the correct live count and deep-links to the Unassigned view.

**Acceptance Scenarios**:

1. **Given** unassigned trips exist, **When** the dispatcher opens the Dispatch Board, **Then** it lists **unassigned trips ordered by pickup time** with resource availability and conflict warnings shown in context. *(§15.6)*
2. **Given** the Dispatch Board, **When** the dispatcher assigns and confirms a trip from it, **Then** the same assignment service, checks, and audit as US1/US2 apply (carrier assignment and vehicle-type matching included). *(§15.6, DISP-001–DISP-009)*
3. **Given** the Control Tower (slice 005), **When** 006 ships, **Then** the **assigned-driver, assigned-vehicle, and carrier filters** and the **"Unassigned" default view** are delivered into it and narrow/scope the list correctly. *(fills 005 FR-003b/FR-006; §15.4)*
4. **Given** the Control Tower board rows, **When** 006 ships, **Then** an **assignment row indicator** reflects whether each trip is assigned. *(fills 005 FR-007)*
5. **Given** the Home Dashboard, **When** 006 ships, **Then** the **"unassigned trips" widget** shows the live count and deep-links to the Unassigned view. *(fills 005 FR-029)*
6. **Given** the Dispatch Board is open, **When** assignment data changes elsewhere, **Then** it refreshes by **polling** (default 30s), never via Realtime. *(STACK §3.10; reuses 005 cadence)*

---

### Edge Cases

- **Trip not in an assignable status**: assignment is offered only on a `validated` trip (and substitution on `assigned`/`confirmed`); attempting to assign a `received`, `cancelled`, or post-`confirmed`-execution trip is refused with a clear message — driven by 003's transition guard, not re-implemented.
- **Concurrent dispatchers**: two dispatchers assigning the same trip (or the same scarce resource) at once must not both win — the single-current-assignment guarantee and 003's optimistic-concurrency guard surface a clear conflict to the loser rather than silently double-booking.
- **Resource becomes ineligible between view, save, and confirm**: a resource that turned blocked/expired since the board last polled is re-checked **at save time and again at confirm time** server-side; a newly-arisen BLOCK refuses confirmation, and a stale client selection does not bypass the check.
- **Partial assignment**: saving without the minimum-required set is refused — the company default requires a **driver and a vehicle** (and a **carrier** when subcontracted); trailer is optional. The minimum set is configurable (Blocked item 1).
- **Override reason empty or whitespace**: rejected — a WARN override requires a non-empty reason.
- **BLOCK conflict**: no override path exists at MVP; the assignment cannot be saved until the conflict is resolved.
- **Carrier approved-for-customer/lane**: out of MVP scope (no approval storage built); only the carrier active/contract/document eligibility checks run. No approval data is invented; the rule returns post-MVP once its scope is defined.
- **Superseded assignment**: history rows are read-only and never re-activated; "restoring" a prior resource is a new reassignment, not an un-supersede.
- **Timezone boundaries**: schedule-overlap windows and "pickup time" ordering compute against `America/Sao_Paulo` business time while timestamps are stored UTC.
- **Permission downgrade mid-session**: a user whose role no longer grants `assign_resources` is refused server-side even if a stale client still shows assign controls (the BFF is the authority).

## Requirements *(mandatory)*

### Functional Requirements

**Assignment write & lifecycle (DISP-001–DISP-004, DISP-009, §11.3, §14.1)**

- **FR-001**: Authorized users MUST be able to assign a **driver** to a trip. *(DISP-001)*
- **FR-002**: Authorized users MUST be able to assign a **vehicle** to a trip. *(DISP-002)*
- **FR-003**: Authorized users MUST be able to assign a **trailer** to a trip where applicable (trailer is optional). *(DISP-003)*
- **FR-004**: Authorized users MUST be able to assign a **carrier/subcontractor** to a trip where applicable. *(DISP-004)*
- **FR-005**: A trip MUST have **at most one current assignment**, enforced server-side (uniqueness on the current-assignment per trip). *(§14.1 cardinality; Decision §30)*
- **FR-006**: **Reassignment/substitution** MUST supersede the previous assignment and **retain it as immutable history** (mark superseded with superseding reference + timestamp; never hard-delete). *(§14.1; Constitution III)*
- **FR-007**: An assignment MUST capture **assignment notes**, the **assigning user and timestamp**, and — on confirmation — the **confirming user and confirmation timestamp**. *(DISP-009, §14.1)*
- **FR-008**: Saving the first assignment MUST drive the trip `validated → assigned`, **confirmation** MUST drive `assigned → confirmed`, and **un-assign** MUST drive `assigned → validated`, all through **slice 003's existing transition service** (with its concurrency guard and audit write); reassignment/substitution MUST NOT by itself change trip status. This slice MUST NOT redefine the status machine. *(§11.3, §12.1, §14.1; reuses 003)*
  - **FR-008a**: **Confirmation** (`assigned → confirmed`) MUST **re-run the eligibility/conflict checks** at confirm time and MUST be **refused if any unresolved BLOCK-severity finding is present** (resource drift since assignment); it MUST be **allowed when only WARN-level findings remain** (already overridden at assignment). *(§11.3 step 8 "operational readiness"; DISP-005–DISP-007)*
- **FR-009**: To move a trip `validated → assigned`, the system MUST require at minimum a **driver and a vehicle**, plus a **carrier when the assigned resources are subcontracted** — i.e. the chosen driver/vehicle carry 002's per-resource `ownership_type = subcontracted` (trips have no `ownership_type` field; the rule is derived from the assigned resources); **trailer is optional**. This minimum-required set is **configuration** (Constitution V) with the stated company default; the broader owned-vs-subcontracted policy (mixed ownership, per-ownership nuances) follows PRD §29 Input #6 and stays open (Blocked item 1). *(DISP-001–DISP-004; §29 Input #6; §13.6 ownership)*

**Conflict & eligibility checks — server-authoritative (DISP-005–DISP-007, §19.2)**

- **FR-010**: All conflict/eligibility checks MUST be evaluated in the **BFF/domain layer** and MUST NOT rely on the UI; the same outcome MUST hold when the UI is bypassed. *(§19.2, STACK §6.1/§6.2; Constitution III)*
- **FR-011**: The system MUST detect **schedule conflicts** — a driver/vehicle/trailer already on another **current** assignment whose trip's planned pickup→delivery window **overlaps** this trip's, excluding cancelled/terminal trips; the **turnaround buffer** MUST be configurable (default 0 min). *(DISP-005, §19.2)*
- **FR-012**: The system MUST flag **resource status** problems: driver `inactive`/`blocked`; vehicle `inactive`/`maintenance`/`blocked`; trailer `inactive`/`blocked` — using 002's `resource_status`. *(DISP-005, §19.2)*
- **FR-013**: The system MUST check **vehicle-type compatibility** against the trip's `planned_vehicle_type`; **MVP default = exact match**; a substitution/compatibility matrix is config-driven future work (not built). *(DISP-006, §19.2)*
- **FR-014**: The system MUST check **carrier eligibility** — `contract_status` (active/suspended/expired), `documentation_status`, and not-archived. The **approved-for-customer/lane** rule (DISP-004, §19.2) is **out of MVP scope** by clarification: 006 builds **no** carrier↔customer/lane approval storage (slice 002 deferred it; its scope is undefined) and revisits it only when the approval model is defined — no approval data is invented. *(DISP-004, DISP-005, §19.2; resolved — see Clarifications)*
- **FR-015**: The system MUST flag **expired or missing documentation** for driver (`license_expiry`), vehicle/trailer (`document_expiry`), and carrier (`documentation_status`), reusing 002's **30-day expiry-warning window**; "expired" and "missing" are distinct from the within-30-day "expiring soon" heads-up. This is the **resource** documentation check, **not** the per-customer trip proof-document checklist (slice 008). *(DISP-007, §19.2)*
- **FR-016**: Each check MUST carry a **severity (BLOCK or WARN)** resolved by **company default then customer-policy override**, implemented as **configuration** (never per-customer code). The **company default is the confirmed table** (see Clarifications / Assumptions): **BLOCK** for resource blocked/inactive, vehicle maintenance, expired documentation, and carrier not-active/contract-expired; **WARN** for schedule overlap, vehicle-type mismatch, missing documentation, and expiring-soon. A **BLOCK** MUST prevent saving; a **WARN** MUST be savable only via override (FR-017). Per-customer overrides remain configurable. *(§19.2 — "configurable by customer and company policy"; Constitution V; §29 Input #6)*
- **FR-017**: Conflict/eligibility warnings MUST be presented **inline** in the assignment UI (§16), but the UI MUST NOT be the authority for whether an assignment is allowed (FR-010). *(§16, STACK §6.1)*

**Override (DISP-008)**

- **FR-018**: A user with **override authority** MUST be able to proceed past a **WARN**-severity conflict by supplying a **required, non-empty reason**; the reason MUST be **persisted on the assignment** and **recorded in audit history**. *(DISP-008, §11.3 step 6, §14.1)*
- **FR-019**: **BLOCK**-severity conflicts MUST NOT be overridable by any role; the assignment remains refused until resolved. *(§19.2; resolved — see Clarifications)*
- **FR-020**: Override authority MUST be **permission-gated and BFF-enforced**: any **`assign_resources` holder** may override a **WARN** (no new permission key — Constitution V); **no role may override a BLOCK** (FR-019). *(DISP-008, §18, STACK §5.2; resolved — see Clarifications)*

**Dispatch Board & operating-board integration (§15.6, §16; fills slice 005 placeholders)**

- **FR-021**: The system MUST provide a **Dispatch Board** listing **unassigned trips ordered by pickup time**, showing **resource availability** — defined minimally as each resource's **current/upcoming current-assignment load** (whether the driver/vehicle/trailer is already on an overlapping or near-term current assignment), sourced from the **same assignment data the schedule-conflict check (FR-011) reads** — **conflict warnings**, and supporting **assignment + confirmation** (including carrier assignment and vehicle-type matching) from the board. *(§15.6)*
- **FR-022**: All Dispatch Board assignment actions MUST use the **same assignment service, checks, override rules, and audit** as the Trip Detail panel (one write path, three entry points). *(§15.6; DRY — Constitution I)*
- **FR-023**: 006 MUST **deliver into the slice-005 Control Tower** the **assigned-driver, assigned-vehicle, and carrier filters** and register the **"Unassigned" default view**. *(fills 005 FR-003b/FR-006; §15.4)*
- **FR-024**: 006 MUST add the **assignment row indicator** to Control Tower rows and supply the **"unassigned trips" count** to the Home Dashboard widget slice 005 left as a placeholder. *(fills 005 FR-007/FR-029; §15.2)*
- **FR-025**: 006 surfaces MUST keep fresh by **polling** (Dispatch Board default 30s, reusing 005's cadence config) and MUST NOT use Supabase Realtime or Edge Functions. *(STACK §3.10; reuses 005)*

**Authorization, audit, localization, reuse (cross-cutting)**

- **FR-026**: The system MUST gate all assignment writes on the **existing `assign_resources`** key from the code-defined 001 catalog (no new key, no DB permissions table — Constitution V), **enforcing it for the first time** in 006; it is granted to **Admin, Operations Manager, Dispatcher, Fleet Coordinator** and MUST be **BFF-enforced**. *(§18, STACK §5.2; mirrors 005's first-enforcement of `view_all_trips`)*
- **FR-027**: Every assignment, reassignment, un-assignment, confirmation, and override MUST be **recorded in audit history**, reusing slice 003's audit semantics and the `trip.*` action family (append-only — Constitution III); assignment references MUST be added to the audited critical-field set. *(§21.5, STACK §5.4; reuses 003)*
- **FR-028**: All user-facing text MUST be **pt-BR** with i18n; timestamps MUST display in `America/Sao_Paulo` while stored in UTC. *(§21.6; SPEC-SLICING global constraints)*
- **FR-029**: This slice MUST consume the **fleet master data (002)** and the **trip domain/status machine/transition service/audit (003)** as the single sources of truth and MUST NOT redefine them; it MUST introduce **no new enum, permission key, package, or worker**, and exactly **one new table** (`trip_assignments`). *(SPEC-SLICING 006; Constitution I/III)*

### Key Entities *(one new table; everything else is reused or read-model)*

- **Trip Assignment** *(NEW table — the one entity this slice owns; PRD §14.1)*: the resources assigned to a trip and the dispatch decision around them — trip reference; driver / vehicle / trailer / carrier references (nullable per applicability); **is-current** flag; **superseded-by / superseded-at** (history chain); **assigned-by / assigned-at**; **confirmed-by / confirmed-at**; **assignment notes**; **override reason** (nullable, set when a WARN is overridden). At most one row per trip has `is_current = true`. Superseded rows are retained, immutable history. *(§14.1)*
- **Resource Eligibility / Availability Read Model** *(BFF projection over 002 fleet + this slice's assignments)*: per resource (driver/vehicle/trailer/carrier) its status, type, document-expiry state, and current-assignment load — the data the panel and Dispatch Board use to show availability and pre-compute warnings. Read-only over 002; introduces no resource fields. *(reuses 002; PRD §15.6)*
- **Conflict / Eligibility Check Result** *(transient, computed server-side — not stored)*: the per-check outcome (check id, affected resource, severity BLOCK/WARN, human-readable reason) returned at assignment time; nothing is persisted except the **override reason** when an authorized user proceeds past a WARN. *(DISP-005–DISP-008, §19.2)*
- **Assignment Policy** *(configuration — not a table, not per-customer code)*: the company-default (and optional per-customer override) for (a) per-check **block/warn severity** and (b) the **owned-vs-subcontracted required-resource** rules; data/config-driven per Constitution V. The **company defaults are confirmed** (Clarifications); per-customer overrides and the broader ownership policy remain configurable (§29 Input #6). *(§19.2, §29 Input #6)*
- **Driver / Vehicle / Trailer / Carrier** *(reused from slice 002 — not redefined)*: the assignable resources, with their `resource_status`, `vehicle_type`/`trailer_type`, `ownership_type`, and document-expiry fields consumed by the checks; `approved_customers`/`approved_lanes` were deferred by 002 to 006 and are **out of MVP scope** by clarification (no approval storage built).
- **Trip** *(reused from slice 003 — not redefined)*: the assignment target; status transitions flow through 003's transition service; assignment data feeds slice 005's filters, views, indicators, and dashboard count.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An authorized dispatcher can assign a **driver, vehicle, trailer, and carrier** to a validated trip and confirm it; the trip ends in `confirmed` with **exactly one** current assignment carrying assigned-by/at, confirmed-by/at, and notes. *(DISP-001–DISP-004, DISP-009, §23)*
- **SC-002**: **100%** of the PRD §19.2 conflict/eligibility checks (schedule overlap, resource status, vehicle-type match, carrier active/approved, documentation expired/missing) are evaluated **server-side** at save time and **cannot be bypassed** by the client. *(DISP-005–DISP-007, §19.2, STACK §6.1)*
- **SC-003**: An assignment attempt with a full conflict check returns its result within **2 seconds** at the medium design scale, so the flow is fast enough for daily dispatcher work. *(§16; §21.2)*
- **SC-004**: An authorized user can clear a **WARN** only by supplying a reason — which is **persisted and audited** — and **0** assignments record a blank override reason; an unauthorized override and any attempt to override a **BLOCK** are refused. *(DISP-008)*
- **SC-005**: After a reassignment, the trip has **exactly one** current assignment pointing to the new resources, the prior assignment is **retained as history** (none deleted), and the trip status is unchanged by the substitution. *(§14.1)*
- **SC-006**: The **Dispatch Board** lists unassigned trips by pickup time and a dispatcher can assign + confirm from it; the board loads within **3 seconds** at medium scale and the Control Tower's assignment filters, "Unassigned" view, row indicator, and dashboard count reflect assignment state. *(§15.6; fills 005 placeholders)*
- **SC-007**: **100%** of assignment, reassignment, un-assignment, confirmation, and override actions appear in append-only audit history. *(§21.5, STACK §5.4)*
- **SC-008**: **No** dispatch surface depends on Supabase Realtime or Edge Functions; freshness is via polling. *(STACK §3.10)*
- **SC-009**: **100%** of dispatch UI labels render in pt-BR and all timestamps display in `America/Sao_Paulo`. *(§21.6)*

## Traceability *(acceptance criteria → PRD)*

| Spec item | Maps to PRD ID / section | Notes |
|-----------|--------------------------|-------|
| US1, FR-001, SC-001 | **DISP-001**; §11.3, §14.1 | Assign driver |
| US1, FR-002, SC-001 | **DISP-002**; §11.3, §14.1 | Assign vehicle |
| US1, FR-003, SC-001 | **DISP-003**; §11.3, §14.1 | Assign trailer where applicable |
| US1, FR-004, FR-014, SC-001 | **DISP-004**; §11.3, §14.1, §19.2 | Assign carrier/subcontractor + carrier eligibility |
| US2, FR-010, FR-011, FR-012, SC-002 | **DISP-005**; §19.2, §15.6 | Schedule conflict + resource status, server-authoritative |
| US2, FR-013, SC-002 | **DISP-006**; §19.2 | Vehicle-type compatibility (exact match default) |
| US2, FR-015, SC-002 | **DISP-007**; §19.2 | Expired/missing resource documentation |
| US3, FR-018, FR-019, FR-020, SC-004 | **DISP-008**; §11.3 step 6, §18 | Override WARN with reason; BLOCK not overridable; permission-gated |
| US1, FR-007, SC-001 | **DISP-009**; §14.1, §11.3 step 8 | Assignment notes + confirmation timestamp |
| US4, FR-005, FR-006, SC-005 | §14.1 cardinality; Decision §30 | One current assignment; supersede + retain history |
| US1/US4, FR-008 | §11.3, §12.1 | validated→assigned / assigned→confirmed / assigned→validated via 003 |
| US5, FR-021, FR-022, SC-006 | §15.6, §16 | Dispatch Board: unassigned by pickup, availability, warnings, assign+confirm |
| US5, FR-023, FR-024 | §15.4, §15.2; fills 005 FR-003b/006/007/029 | Assignment filters, "Unassigned" view, row indicator, dashboard count |
| FR-016, FR-008a, FR-009 | **§19.2**; §29 Input #6 | Block/warn severity + confirm re-check + minimum-required set: company defaults confirmed (Clarifications); per-customer/broader-ownership overrides stay configurable |
| FR-025, SC-008 | §22 Phase 3; STACK §3.10 | Polling-only freshness; no Realtime/Edge Functions |
| FR-026 | §18; STACK §5.2 | First-enforces existing `assign_resources` (no new key) |
| FR-027, SC-007 | §21.5; STACK §5.4 | Assignment changes audited (append-only) |
| FR-028, SC-009 | §21.6 | pt-BR, America/Sao_Paulo |
| FR-029 | SPEC-SLICING 006; §14.1 | Reuses 002/003; one new table, no new enum/key/package/worker |
| Out of scope: resource recommendation | **DISP-010** → Later | Recommend resources by schedule/lane/type — not built |
| Out of scope: execution events / exceptions / SLA risk | EVT/EXC/SLA-* → slice 007 | Milestones, exceptions, SLA engine not here |
| Out of scope: documents / billing | DOC/BILL-* → slice 008 | Proof-document checklist & billing not here |
| MVP acceptance: "Dispatch can assign resources and confirm trips" | **§23**, §22 Phase 3 | This slice satisfies the dispatch acceptance line |

## Scope

### In scope

- **Trip Assignment** entity (one new table): driver/vehicle/trailer/carrier references, single-current-assignment guarantee, supersession history, notes, override reason, assigned/confirmed user+timestamps.
- **Assignment write path** (one service, three entry points): assign, reassign/substitute, un-assign, and confirm — driving 003's status transitions and audit.
- **Server-authoritative conflict & eligibility checks** (PRD §19.2): schedule overlap, resource status, vehicle-type compatibility (exact match), carrier active/contract/document eligibility, expired/missing resource documentation — each with configurable BLOCK/WARN severity (documented company defaults). (The carrier approved-for-customer/lane rule is out of MVP scope — see Clarifications.)
- **Override** of WARN-severity conflicts with a required, persisted, audited reason (permission-gated).
- **Dispatch Board** (§15.6): unassigned-by-pickup queue, resource availability, inline conflict warnings, assign + confirm.
- **Delivery into slice 005's shell**: assigned-driver/vehicle/carrier filters, the "Unassigned" default view, the assignment row indicator, the Trip Detail assignment panel, and the Home Dashboard "unassigned trips" count.
- **First enforcement** of the existing `assign_resources` key; BFF-enforced authorization; append-only audit of assignment changes; pt-BR + timezone handling; polling-only freshness.

### Out of scope (owned by later slices)

- **Resource recommendation** based on schedule, lane, and vehicle type (**DISP-010** → Later).
- **Execution events / manual timeline, exception management, and the SLA risk engine** (slice 007 — EVT/EXC/SLA-*); the Dispatch Board shows conflict warnings, not execution milestones or SLA risk.
- **Documents and billing** — the per-customer trip **proof-document checklist**, document verification, billing readiness, rates, and export (slice 008 — DOC/BILL-*). The documentation check here reads **resource** master-data document fields only.
- **Status-machine, master-data, and audit redefinition** — all reused from 003/002/001.
- **A new permission key, enum, package, or worker** — none introduced.
- **Carrier approved-for-customer/lane rule, its storage, and management UI** — out of MVP scope by clarification; only carrier active/contract/document eligibility is enforced. Revisited post-MVP once the approval scope is defined.
- **Vehicle-type substitution/compatibility matrix** beyond exact match (config-driven future work — YAGNI).

## Assumptions

- **Assigners = `assign_resources` holders**: Admin, Operations Manager, Dispatcher, Fleet Coordinator (001 catalog); the key is enforced for the first time in 006. Control Tower/Finance/Executive Viewer can view assignments (via 005) but not create them.
- **Status semantics**: assignment is offered on `validated`; substitution on `assigned`/`confirmed`; confirmation moves `assigned → confirmed`; un-assign moves `assigned → validated`. All transitions go through 003's existing transition service (concurrency guard + audit). Reassignment does not itself change status.
- **Schedule overlap** = intersection of planned pickup→delivery windows of a resource's other **current** assignments, excluding cancelled/terminal trips; **turnaround buffer defaults to 0 minutes**, configurable by Ops.
- **Vehicle-type compatibility** defaults to **exact match** of `vehicle_type` to `planned_vehicle_type`; a richer compatibility matrix is config-driven future work.
- **Documentation check** reads 002 resource fields (driver `license_expiry`, vehicle/trailer `document_expiry`, carrier `documentation_status`) with 002's **30-day** expiry-warning window; it is distinct from slice 008's trip proof-document checklist.
- **Block/warn company defaults** *(confirmed via Clarifications; the MVP build/test target)*: resource `blocked`/`inactive`, vehicle `maintenance`, expired documentation, and carrier not-active/contract-expired are **BLOCK**; schedule overlap, vehicle-type mismatch, missing (vs expired) documentation, and the within-30-day expiring heads-up are **WARN**. **Per-customer overrides remain configuration** (Constitution V) and are not required for MVP build.
- **Owned-vs-subcontracted required-resource defaults** *(confirmed via Clarifications; see Blocked item 1 for the residual policy)*: a **driver and vehicle are always required** to leave `validated`, a **carrier is additionally required when subcontracted**, and **trailer is optional**. A subcontracted trip records the carrier and its driver/vehicle up front. Configurable; mixed-ownership and per-ownership nuances follow §29 Input #6.
- **Override** requires a non-empty reason; **any `assign_resources` holder** may override a WARN, and **BLOCK is not overridable by any role**; no new permission key is invented (confirmed via Clarifications).
- **Carrier approved-for-customer/lane** check is **not-configured ⇒ not-run** (no invented approval data); carrier active/contract/document checks always run.
- **Read models live in the BFF** (STACK §6.2); the client polls (Dispatch Board default 30s, reusing 005's cadence config). Single-current-assignment is enforced by a server-side uniqueness guarantee; conflict-lookup and unassigned-queue queries are backed by indexes added at plan time.
- **Scale (medium)**, consistent with 005: ~1k–10k active trips; assignment and conflict checks are designed for indexed lookups, not full scans.
- **Desktop-first** operational UI (§16), responsive enough for tablet.

## Dependencies

- **Slice 001 (Platform, Access, App Shell)**: auth/session, BFF auth context, the code-defined permission catalog whose existing **`assign_resources`** key this slice first enforces, the append-only audit-log foundation, i18n, and the app shell the Dispatch Board mounts in.
- **Slice 002 (Master Data & Fleet)**: **Driver, Vehicle, Trailer, Carrier** and their `resource_status`, `vehicle_type`/`trailer_type`, `ownership_type`, and document-expiry semantics + the 30-day expiry-warning window — the resources assigned and the data the checks read. `approved_customers`/`approved_lanes` were deferred by 002 to 006 and are out of MVP scope (see Clarifications).
- **Slice 003 (Trip Domain & Lifecycle)**: the `trips` model, the 18-value status machine and its `validated`/`assigned`/`confirmed` transitions, the **transition service** (concurrency guard) assignment drives, and the audit semantics assignment changes reuse. Consumed without redefinition.
- **Slice 005 (Control Tower)**: the operating-board **shell** this slice fills — the Trip Detail assignment placeholder (005 FR-014), the assignment filter/indicator/view framework (005 FR-003b/006/007), the Home Dashboard "unassigned" widget slot (005 FR-029), and the polling-cadence configuration.
- **Forward dependents (not blockers)**: slice 007 (execution events, exceptions, SLA risk) and slice 008 (documents, billing) consume assignment data but are not required for 006 to ship.

## Blocked / Open for business sign-off

> Per the feature constraints and Constitution Principle II, this slice ships a **configurable, default-aware** assignment flow. The clarification session **resolved items 3 and 4 outright** and **pinned the MVP build/test defaults for items 1 and 2** (only per-customer / broader-ownership overrides remain — as configuration); items 5 and 6 are low-risk open defaults. **None of these block building the feature** — the remaining open parts block only declaring the affected *business policy* final, and **no customer, document, carrier-approval, SLA, or billing values are invented.**

1. **Owned-fleet vs subcontracted assignment policy** *(PRD §29 Input #6; §13.6; gates "assignment policy")* — **Minimum-required set resolved (Clarifications): driver + vehicle always, carrier when subcontracted, trailer optional** (configurable). What remains open is the **broader ownership policy** — whether mixed-ownership trips (e.g., owned driver + subcontracted vehicle) are allowed and any per-ownership nuances — pending §29 Input #6. Not a blocker for the MVP assignment guard.
2. **Blocking-vs-warning severity mapping** *(PRD §19.2; §29 Input #6)* — **Resolved (Clarifications): the company-default severity table is confirmed** as the MVP build/test target (see Assumptions), implemented as **configuration**. Only **per-customer policy overrides** remain open — they are config data (no build blocker) and await per-customer policy from §29 Input #6.
3. **Carrier approved-for-customer/lane rule** *(DISP-004; §14.1 `approved_customers`/`approved_lanes`; deferred by slice 002 to 006)* — **Resolved (Clarifications): out of MVP scope.** 006 builds **no** approval storage and enforces only carrier active/contract/document eligibility; the approved-for rule (per-customer vs per-lane, ownership, management UI) is revisited post-MVP once its scope is defined. **Not a blocker for 006** — listed here only to track the deferred business model.
4. **Override authority & BLOCK-override policy** *(DISP-008; §18)* — **Resolved (Clarifications): any `assign_resources` holder may override a WARN with a reason; a BLOCK is absolute and not overridable by any role**, using only the existing permission key (no new key). A future senior BLOCK-override would be a deliberate permission-catalog change. **Not a blocker for 006.**
5. **Vehicle-type compatibility rules** *(DISP-006; minor)* — MVP default is **exact match**. Whether substitutions are allowed (a compatibility/substitution matrix) needs Ops definition; it would be added as **configuration**, not code branches. Open, low-risk.
6. **Schedule-overlap turnaround buffer** *(DISP-005; minor)* — MVP default buffer = **0 minutes** (pure window intersection). The real turnaround/rest buffer for owned vs subcontracted resources needs Ops input; it is **configuration**. Open, low-risk.
