# Feature Specification: Execution Events, Exceptions, SLA Risk, and In-App Alerts

**Feature Branch**: `007-execution-events-exceptions`

**Created**: 2026-05-31

**Status**: Draft

**Input**: User description: "Control tower users can track trip execution, update milestones, log exceptions, and identify SLA risk. Users can add standard trip events; status changes automatically record timestamp, user, and previous/new status; the trip timeline displays events chronologically. Exceptions carry category, reason code, severity, owner, status, responsible party, description, timestamps, and attachments, with statuses Open/Monitoring/Resolved/Cancelled. SLA risk covers missing assignment, missed confirmation, delayed origin arrival, delayed loading, delayed departure, delayed destination arrival, and open high-severity exceptions. In-app alerts cover the MVP alert cases in PRD §17. Worker jobs recalculate SLA risk and generate in-app alerts. Per-customer SLA rules are required before final SLA sign-off; if SLA inputs are unavailable, use explicit default rules and mark customer SLA sign-off as blocked. Out of scope: GPS-based events, geofence detection, external email/SMS/WhatsApp/webhook/portal notifications, configurable external alert channels, billing readiness."

**Source PRD sections**: §11.4, §11.5, §12.2, §13.7, §13.8, §13.10, §14.1, §15.4, §15.5, §15.8, §17, §19.3, §20.2, §22 (Phase 3), §23, §29 (Input #2), §30

**Primary requirement IDs**: CUST-005, EVT-001, EVT-002, EVT-003, EVT-004, EVT-005, EXC-001, EXC-002, EXC-003, EXC-004, EXC-005, EXC-006, SLA-001, SLA-002, SLA-003, SLA-004

**Slice ownership**: This is the **execution-tracking write surface and SLA/alert engine** over the trip domain — slice 007 in `docs/SPEC-SLICING.md`. It owns: manual **execution-milestone updates** and the **interactive trip timeline** (§11.4, §13.7); the **Exception** lifecycle (§11.5, §13.8) and the **Exception Management** screen (§15.8); **per-customer SLA rules** (CUST-005, §14.1) and **server-authoritative SLA-risk classification** (§12.2, §13.10, §19.3); and **in-app alert generation** for the MVP §17 cases whose inputs already exist. It **reuses, never redefines**: the trip **status machine** and **status-transition service** (003 — which already records a `trip_events` row on every transition), the append-only **`trip_events`** log (003 — created there, its `trip_event_type`/`trip_event_source` enums explicitly "extended by 007", its `exception_id` a forward hook whose FK 007 wires, and the timeline already rendered **read-only** by 005), the nullable **`trips.sla_status`** placeholder column (003 — "NOT computed here; 007 owns it"), master data (002), the **assignment**/confirmation state that signals unassigned/unconfirmed risk (006), and the **read-model framework, Trip-Detail shell, Control-Tower board, and Home Dashboard** whose timeline/exception/SLA placeholders this slice fills (005), plus the auth/audit/i18n foundation (001). Authorization adds **no new permission key**: it **first-enforces** the pre-declared 001 keys **`update_trip_status`** (milestone/status updates — Admin/Ops-Manager/Dispatcher/Control-Tower), **`create_exceptions`** and **`resolve_exceptions`** (exception lifecycle — Admin/Ops-Manager/Dispatcher/Control-Tower/Fleet-Coordinator), and **reuses `manage_commercial_data`** (002, already enforced — Admin/Ops-Manager) for per-customer SLA-rule administration; reads stay on **`view_all_trips`** — mirroring 004/`import_trips`, 005/`view_all_trips`, 006/`assign_resources`. SLA and alert authority is **server-side** (a pure SLA-risk evaluator in `@brazil-tms/shared` + the single Postgres-backed worker, never the client). New tables: **`exceptions`**, **`reason_codes`**, **`customer_sla_rules`**, and an in-app **`alerts`** store; `trips.sla_status` (existing) is computed here — alongside a new sibling **`trips.sla_reasons`** column — and `trip_events` is extended in use, not recreated. Open items are **configurable defaults / deferred slice inputs, not blockers and not invented** (Constitution II): per-customer SLA rules are gated (§29 Input #2 — default rules + SLA sign-off blocked until supplied), per-milestone planned times are deferred (loading/departure risk from time-in-status), and two §17 alert cases ("missing required documents", "billing blocked by missing proof") are wired only when slices **008 (Documents)** and **009 (Billing)** supply their inputs.

## Overview & Intent *(why this feature exists)*

Slices 003–006 gave the control tower a trip that can be imported, validated, viewed, assigned, and confirmed — but once the truck is on the road, the operating picture goes flat. Slice 005 deliberately left the Trip-Detail **exception** list and **SLA-risk** indicator as empty placeholders, renders the **timeline read-only**, and shows the dashboard's at-risk/exception/on-time widgets as labelled zero-states — all explicitly "owned by slice 007". Slice 003 created the append-only `trip_events` log noting "007 surfaces/extends it", left `trip_events.exception_id` as a forward hook, and parked `trips.sla_status` as a placeholder "007 owns". This feature turns the control tower into a **live operating board**: dispatchers and ops record what actually happened (at origin, loaded, departed, at destination, unloaded), log what went wrong (a breakdown, a customer delay, a no-show), and **see which trips are at risk before the customer calls**.

The value is the **risk signal**, not the data entry. Anyone can type a timestamp; the point is that the moment an arrival is late, a confirmation cutoff passes, or a high-severity exception opens, the trip's **SLA-risk state** flips and an **in-app alert** surfaces on the board and dashboard — so the team works the next problem instead of discovering it afterward. SLA classification is **server-authoritative**: a pure evaluator computes risk from the planned windows customers actually provide (pickup, delivery, confirmation cutoff) plus assignment/exception state, recalculated both **on relevant changes** (in the BFF, for immediate UI truth) and **periodically by the worker** (so time-based risk like a passed cutoff appears with no user action). Freshness on every surface is **polling via TanStack Query** — never Realtime (STACK §3.10), and the background work runs on the **single Node worker + Postgres-backed queue** — never Redis/BullMQ or Edge Functions (STACK §3.11).

Customer variation is **config-driven** (Constitution): one Exception engine with configurable **reason codes**, and one SLA evaluator parameterized by **per-customer SLA rules**. Where a business input is missing it is made **configurable with an explicit default and the affected sign-off marked blocked** — never invented. Per-customer SLA rules are gated (§29 Input #2): until Ops/Customers supply them, the evaluator runs on **company-default rules** and **final customer SLA sign-off is blocked per customer**. Per-milestone planned times (loading, departure) are not yet provided, so milestone-level risk is derived from **time-in-status** (§12.2). And because the §17 alert cases for "missing documents" and "billing blocked" depend on data owned by slices **008** and **009**, those two are deferred; the other six ship here.

## Clarifications

### Session 2026-05-31 *(design decisions resolved while specifying; informed defaults — business-input gaps are recorded under "Blocked / Open for business sign-off")*

- Q: Which permission keys gate the write surfaces, and does this slice add any? → A: **No new key.** It **first-enforces** three pre-declared 001 keys (owner-feature 007 in the matrix): **`update_trip_status`** for recording execution milestones / status changes (granted to **Admin, Operations Manager, Dispatcher, Control Tower**), **`create_exceptions`** for opening exceptions (Admin, Ops Mgr, Dispatcher, Control Tower, Fleet Coordinator), and **`resolve_exceptions`** for working/closing them (same five; Fleet Coordinator "Limited" ◐). Per-customer SLA-rule administration **reuses `manage_commercial_data`** (added + already enforced by 002 — Admin, Operations Manager), since SLA rules are per-customer commercial config; **no `configure_sla` key exists or is added**. All **reads** (timeline, exceptions, SLA indicators, alerts) stay on **`view_all_trips`**.
- Q: Is "Trip Event" a new table? → A: **No — reused from 003.** `trip_events` is the append-only log created in slice 003 (REVOKE UPDATE/DELETE; insert+select only), with a `trip_event_type` enum (`status_change, origin_arrived, loaded, departed, destination_arrived, unloaded, completed`) and `trip_event_source` enum that 003 explicitly says **"007 extends via migration"**, and an `exception_id` column that is a **forward hook with no FK until 007**. This slice **writes** milestone/exception event rows, **extends the event vocabulary** as needed, **wires the `exception_id` FK** to the new `exceptions` table, and **reads** the rows as the timeline — it does not recreate or mutate (append-only) the table.
- Q: How do manual milestone updates relate to the trip status machine? → A: A manual milestone update **is** a status transition driven through **slice 003's existing `transitionTripStatus` service** (its concurrency guard, legal-transition table, and audit write); that service already records the `trip_events` row capturing **status before/after, actor, source, and timestamp** (EVT-002). This slice **does not redefine the status machine** (§12.1). Free-form events/notes (EVT-003) are recorded without a status change.
- Q: Is "Trip SLA status" a new field? → A: **No — the `trips.sla_status` column already exists** (003) as a nullable placeholder "007 owns". This slice **computes and populates** it (On Track / At Risk / Late / Breached) plus the set of contributing **risk reasons**; it is never computed client-side.
- Q: Exception "responsible party" — reuse 003's cancellation enum? → A: **No.** 003's `cancellation_responsible_party` has four values (`customer_caused, brazil_transports_caused, carrier_caused, unknown`); EXC-005 requires a **fifth — force majeure**. Exceptions therefore use their **own five-value responsible-party set** (customer-caused, Brazil Transports-caused, carrier-caused, force majeure, unknown), not the cancellation enum.
- Q: Are in-app alerts stored or derived on the fly? → A: **Stored.** A lightweight **`alerts`** record is generated (by the worker, idempotently per trip+case) so alerts can be **listed, counted, and acknowledged/dismissed** and not re-spammed. The PRD names the alert **cases** (§17) but no alert entity in §14; introducing a minimal in-app alert store is an informed default, **not** an external-channel notification system (those stay out of scope).
- Q: Which §17 alert cases ship in this slice? → A: The **six** whose inputs exist by slice 006/007: (1) within window & still **unassigned**, (2) within window & **not confirmed**, (3) **missed origin arrival**, (4) **missed departure**, (5) **missed destination arrival**, (6) **high-severity exception opened**. The two depending on later slices — "completed but **missing required documents**" (008) and "billing item **blocked by missing proof**" (009) — are **deferred** (the framework accepts them when those inputs land). Resolved as scope; not invented.
- Q: SLA risk for loading/departure with no per-milestone planned times? → A: Derive those from **time-in-status** against a configurable default threshold (§12.2), not per-milestone planned times. Pickup/delivery/confirmation risk uses the planned windows + confirmation cutoff customers **do** provide. Open per §29 Input #2.

### Session 2026-05-31b *(clarification pass before planning)*

- Q: What are the legal exception status transitions (Open/Monitoring/Resolved/Cancelled)? → A: **Flexible with terminal close.** Open↔Monitoring freely; **Monitoring is optional** (Open→Resolved is allowed); Open or Monitoring → **Resolved or Cancelled**. **Resolved and Cancelled are terminal — no reopen**; a recurrence is logged as a **new** exception (matches the existing "resolved-then-recurring" edge case + append-only ethos).
- Q: Uniqueness / re-fire rule for in-app alerts per (trip, case)? → A: **Active-scoped, re-fires.** At most **one ACTIVE alert per (trip, case)** (partial-unique on the active state); the worker **auto-resolves** it when the condition clears; if the condition **recurs later, a fresh alert is generated**. Idempotency is scoped to *active*, not to all-time. *(Refined by Session 2026-05-31c: the uniqueness scope is widened to **active OR acknowledged** so a dismissed-but-still-true alert is not re-spammed — see FR-024.)*
- Q: Semantics of an exception's `owner` (EXC-002)? → A: **Required, defaults to creator.** Owner is a **required internal-user reference**, **defaults to the creating user**, and is **reassignable** to any internal user — so every exception has an accountable owner for the queue and the "filter by owner" requirement.
- Q: Periodic worker cadence for time-based SLA risk (cutoffs, missed arrivals)? → A: **~5-minute sweep (configurable)**, in addition to immediate on-change recalc. Balances freshness of time-based risk against worker/DB load for linehaul windows.

### Session 2026-05-31c *(pre-plan agents-team pass: SLA trigger→state mapping, multi-trigger precedence, alert acknowledgement, SLA storage shape, milestone recordability)*

- Q: How do the seven SLA-risk triggers map to the four states (On Track/At Risk/Late/Breached), and is "Breached" reachable in MVP? → A: **Window-miss ⇒ Late; everything else ⇒ At Risk.** *Late* = a **missed planned origin/destination arrival window**; *At Risk* = missing assignment, missed confirmation, delayed loading, delayed departure, or an open high-severity exception; *On Track* = none fired. **Breached is NOT reachable in MVP** — it requires a customer-supplied SLA threshold (gated §29 Input #2); the value exists in the domain but stays unset until per-customer thresholds land. This resolves the unstated states in AS2 (missed confirmation) and AS6 (delayed loading/departure) and aligns with the spec's own AS1/AS3/AS4.
- Q: When several triggers fire at once, how is the single stored `sla_status` chosen? → A: **Worst-state-wins.** `sla_status` is the most severe of all fired triggers, ordered **On Track < At Risk < Late < Breached**; the full set of contributing **reasons** is retained alongside it (a Late trip with an open high-severity exception is *Late* and lists both reasons).
- Q: What happens when a user acknowledges/dismisses an active alert whose condition is still true? → A: **Suppress until it clears.** An acknowledged alert MUST NOT be regenerated while its condition still holds; it re-fires **only after the condition clears and later recurs**. The per-(trip, case) uniqueness scope is therefore **active OR acknowledged** (not active alone), and the worker **auto-resolves** the acknowledged row once the condition clears — refining the 2026-05-31b "active-scoped re-fire" rule so dismissal is meaningful on persistent conditions.
- Q: Where do the computed `sla_status` value and its contributing reasons live (003 left `trips.sla_status` a single nullable `text` placeholder with no reasons field)? → A: **Keep `trips.sla_status` as `text`** (003's existing type, validated to the four values via Zod + a CHECK constraint) and **add a new `trips.sla_reasons text[]` column** for the active reasons, both written atomically by the evaluator. **No new enum** — reasons are a small fixed set always read alongside the status, never queried independently.
- Q: Are the optional Loading/Unloading sub-statuses (§12.1) user-recordable in 007, and how? → A: **Recordable as status transitions via the existing `status_change` event type** (new_status = `loading`/`unloading`) — **no new `trip_event_type` member** is added for them. FR-001's recordable milestone set expands to include **Loading** and **Unloading** as optional sub-states; this is what makes FR-018's time-in-status "delayed loading/unloading" risk reachable and testable.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Record execution milestones and read the trip timeline (Priority: P1)

A dispatcher tracking a confirmed trip records each real-world milestone as it happens — vehicle **at origin**, **loaded**, **in transit** (departed), **at destination**, **unloaded** — and the trip's status advances accordingly. Every change is stamped automatically with who, when, and the status before/after, and the **Trip-Detail timeline** (read-only since 005) becomes **interactive**, showing the full sequence in chronological order with planned-vs-actual comparison.

**Why this priority**: This is the core "control tower can update statuses and the timeline shows planned and actual events" acceptance bar (§23) and the foundation every other story reads from — SLA risk and alerts are computed off these events. Without it there is no execution tracking.

**Independent Test**: Seed a `confirmed` trip (from 003/006). As a user with `update_trip_status`, advance it through the milestone statuses; assert each transition created a `trip_events` row with actor, source, timestamp, and status before/after, that the timeline renders them oldest-to-newest with planned-vs-actual deltas, and that a user lacking `update_trip_status` is refused.

**Acceptance Scenarios**:

1. **Given** a `confirmed` trip and a user with `update_trip_status`, **When** they record the **At Origin** milestone, **Then** the trip advances to `at_origin` and a timeline event captures actor, source, timestamp, and previous/new status. *(EVT-001, EVT-002, §11.4)*
2. **Given** a trip with several recorded events, **When** any user with `view_all_trips` opens Trip Detail, **Then** the **timeline** lists all events in chronological order. *(EVT-005, §15.5)*
3. **Given** a trip with planned pickup/delivery windows, **When** actual milestone timestamps are recorded, **Then** the timeline shows the **planned-vs-actual** comparison for each. *(EVT-004, §12.2)*
4. **Given** a user **without** `update_trip_status`, **When** they attempt to record a milestone, **Then** the action is refused and the trip is unchanged. *(§16; reuses 001 auth)*
5. **Given** any status change driven through the transition service, **When** it succeeds, **Then** the event is recorded **automatically** (no separate manual step) with previous/new status. *(EVT-002, §11.4; reuses 003)*
6. **Given** a free-form note or non-status event, **When** a user adds it (with an attachment where supported), **Then** it appears on the timeline without changing trip status. *(EVT-003)*

---

### User Story 2 - Log, monitor, and resolve exceptions (Priority: P1)

When something goes wrong, a dispatcher or control-tower user creates an **exception** on the trip — choosing a **reason code** (which suggests a default severity and responsible party), setting **severity**, **responsible party**, **owner**, and **description**, attaching evidence where supported — and works it through **Open → Monitoring → Resolved** (or **Cancelled**), recording closure notes and a resolution timestamp. Exceptions appear on Trip Detail (filling 005's placeholder) and in a filterable **Exception Management** queue.

**Why this priority**: "Control tower can log exceptions" is an explicit MVP acceptance criterion (§23); a high-severity open exception is also a direct SLA-risk trigger (Story 3), so this must exist before risk is meaningful.

**Independent Test**: On a seeded trip, create an exception with a reason code; assert category/severity/responsible-party/owner/status/description/timestamps persist and the reason code's defaults apply; move it Open→Monitoring→Resolved with closure notes; assert it appears in Exception Management filterable by severity, customer, lane, reason, owner, and age; assert a user without `create_exceptions` cannot open one and one without `resolve_exceptions` cannot resolve one.

**Acceptance Scenarios**:

1. **Given** a trip and a user with `create_exceptions`, **When** they create an exception with a **reason code, severity, responsible party, owner, and description**, **Then** it is saved **linked to the trip** with status **Open** and an opened timestamp. *(EXC-001, EXC-002, §11.5)*
2. **Given** a reason code with a default severity and default responsible party, **When** it is selected, **Then** those defaults pre-fill but remain **editable**. *(EXC-004, §14.1)*
3. **Given** an open exception and a user with `resolve_exceptions`, **When** they transition it through **Monitoring** and then **Resolved**, **Then** the status updates and a **resolved timestamp** and **closure notes** are recorded. *(EXC-003, §11.5)*
4. **Given** exceptions across many trips, **When** a user opens **Exception Management**, **Then** they can filter by **severity, customer, lane, reason, owner, and age**. *(EXC-001..EXC-003, §15.8)*
5. **Given** a user marks responsible party, **When** they choose among **customer-caused, Brazil Transports-caused, carrier-caused, force majeure, unknown**, **Then** the selection is stored for SLA/billing/dispute reporting. *(EXC-005, EXC-006)*
6. **Given** a user **without** the relevant key, **When** they attempt to create (`create_exceptions`) or resolve (`resolve_exceptions`) an exception, **Then** the action is refused. *(§16)*

---

### User Story 3 - See server-computed SLA risk on the control tower (Priority: P1)

The control tower shows, per trip and across the board, **why a trip is at risk** — missing assignment, missed confirmation, delayed origin arrival, delayed loading, delayed departure, delayed destination arrival, or an open high-severity exception — as a server-computed **SLA-risk state** (On Track / At Risk / Late / Breached) with the contributing reasons, written to `trips.sla_status` and recalculated on relevant changes and periodically by the worker.

**Why this priority**: SLA-risk visibility is the headline outcome ("identify SLA risk") and the Phase-3 exit bar ("at-risk indicators"); it depends on Stories 1–2 for milestone/exception inputs and on 006 for assignment state, so it is P1 but built on them.

**Independent Test**: Seed trips covering each of the seven risk triggers (e.g., one validated-but-unassigned past its window, one with a passed confirmation cutoff, one with an open high-severity exception). Run the SLA evaluator/worker recalculation; assert each trip's `sla_status` and listed reasons match expectations, that the Control-Tower board and "At risk" view surface them, that the Home Dashboard at-risk count reflects them, and that the same answer comes from the server (never computed client-side).

**Acceptance Scenarios**:

1. **Given** a trip within its configurable window that is **still unassigned**, **When** SLA risk is evaluated, **Then** it is flagged **At Risk** with reason **missing assignment**. *(SLA-003, §12.2)*
2. **Given** a trip whose **confirmation cutoff** has passed without confirmation, **When** evaluated, **Then** it is flagged **At Risk** with reason **missed confirmation**. *(SLA-003, §12.2; reads 006 confirmed-at)*
3. **Given** a trip past its planned **origin/destination arrival** window, **When** evaluated, **Then** it is flagged **Late** with the corresponding **delayed arrival** reason. *(SLA-001, SLA-002, SLA-003)*
4. **Given** a trip with an **open high-severity exception**, **When** evaluated, **Then** it is flagged **At Risk** with reason **open high-severity exception**. *(SLA-003, EXC-006)*
5. **Given** changing trip state, **When** a relevant change occurs (assignment, confirmation, milestone, exception) **or** the worker recalculation runs, **Then** `sla_status` is updated **server-side** and reflected on the board, "At risk" view, Trip Detail, and dashboard count via polling. *(SLA-003, SLA-004, §13.10, STACK §3.10/§3.11)*
6. **Given** delayed **loading** or **departure** with no per-milestone planned time supplied, **When** evaluated, **Then** the trip is flagged **At Risk** with the corresponding **delayed loading/departure** reason, derived from **time-in-status** against a configurable default. *(SLA-003, §12.2; §29 Input #2)*

---

### User Story 4 - Receive in-app alerts for the MVP cases (Priority: P2)

Control-tower users see **in-app alerts** for the time-critical conditions defined in §17 — a trip still unassigned or unconfirmed within its window, a missed origin/departure/destination arrival, or a high-severity exception just opened — generated by the worker, surfaced on the board/dashboard, and dismissible so the queue reflects real outstanding work.

**Why this priority**: Alerts are the proactive layer on top of the SLA-risk state (Story 3); valuable but a thin generation+surface step once risk classification exists, so P2.

**Independent Test**: Drive trips into each of the six in-scope alert conditions; run the worker alert generation; assert exactly one alert per (trip, case) is created (idempotent — no duplicates on re-run), that alerts surface in the in-app alert area and feed the dashboard counts, that acknowledging an alert removes it from the active list, and that no external channel (email/SMS/etc.) is invoked.

**Acceptance Scenarios**:

1. **Given** a trip within its configurable window and **still unassigned** (or **not confirmed**), **When** the worker runs, **Then** the corresponding in-app alert is created. *(§17 cases 1–2)*
2. **Given** a trip that has **missed planned origin / departure / destination arrival**, **When** the worker runs, **Then** the corresponding in-app alert is created. *(§17 cases 3–5)*
3. **Given** a **high-severity exception is opened**, **When** the worker runs (or on the triggering change), **Then** a high-severity-exception alert is created. *(§17 case 6)*
4. **Given** an alert already exists for a (trip, case), **When** the worker re-runs while the condition persists, **Then** **no duplicate** alert is created. *(idempotent generation)*
5. **Given** an active alert, **When** a user **acknowledges/dismisses** it, **Then** it leaves the active list and the dashboard count updates. *(in-app surface)*
6. **Given** any alert, **When** it is generated, **Then** it stays **in-app only** — no email/SMS/WhatsApp/webhook/portal delivery. *(scope boundary)*

---

### User Story 5 - Configure per-customer SLA rules (Priority: P2)

An Operations Manager configures **per-customer SLA rules** — pickup/delivery on-time definitions and tolerances, the confirmation cutoff lead time, and the at-risk warning window — optionally scoped to a lane or vehicle type, with effective dates. Until a customer's rules are supplied, the evaluator runs on **company defaults** and that customer's **SLA sign-off is marked blocked**.

**Why this priority**: SLA rules parameterize Story 3, but the gated business input (§29 Input #2) means the system must run on defaults first; configuring real rules is the path to lifting the block, so P2.

**Independent Test**: As a user with `manage_commercial_data`, create a customer SLA rule; assert the evaluator uses it for that customer's trips while others fall back to defaults; assert a customer with no rule is reported as **SLA sign-off blocked**; assert a user without `manage_commercial_data` cannot edit rules.

**Acceptance Scenarios**:

1. **Given** a user with `manage_commercial_data`, **When** they set a customer's **pickup/delivery rules, confirmation cutoff, and at-risk window**, **Then** the rule is saved and used in SLA evaluation for that customer. *(CUST-005, SLA-001, SLA-002)*
2. **Given** a customer with **no SLA rule**, **When** SLA risk is evaluated, **Then** **company-default** rules apply and the customer is reported as **SLA sign-off blocked**. *(§29 Input #2; Constitution II)*
3. **Given** a rule scoped to a lane or vehicle type with effective dates, **When** a trip matches the scope and date, **Then** the scoped rule takes precedence over the default. *(CUST-005, §14.1)*
4. **Given** a user **without** `manage_commercial_data`, **When** they attempt to edit SLA rules, **Then** the action is refused. *(§16)*

---

### Edge Cases

- **Status transition refused by the machine**: an invalid milestone (e.g., recording "Loaded" before "At Origin") is rejected by **003's transition guard**, not re-implemented here; the timeline is unchanged and the user sees why.
- **Out-of-order / backdated actuals**: a recorded actual timestamp earlier or later than expected is accepted and surfaced as a planned-vs-actual delta; it does not rewrite the immutable plan (plan is immutable post-import, §30).
- **Cancelled or terminal trip**: milestones and SLA risk are not evaluated for trips in terminal/cancelled states; existing exceptions remain readable.
- **Exception on an already-completed trip**: allowed (e.g., a post-hoc dispute), but does not reopen execution; feeds dispute reporting (EXC-006).
- **Resolved-then-recurring problem**: resolving an exception does not delete it (append-only ethos); a new occurrence is a new exception, with history retained.
- **Concurrent milestone updates**: two users advancing the same trip are serialized by 003's concurrency guard (`STALE_TRANSITION`); the loser is rejected, not silently overwritten.
- **SLA rule effective-date gaps / overlaps**: when no active rule matches, fall back to company defaults; overlap resolves to the most specific in-scope, currently-effective rule (**lane scope > vehicle-type scope > customer-default**, tie-break latest `effective_start`).
- **Multiple risk triggers on one trip**: `sla_status` shows the **most severe** state by the ordering On Track < At Risk < Late < Breached, while `sla_reasons` lists **every** contributing trigger. *(Clarifications 2026-05-31c)*
- **Alert condition clears before acknowledgement**: the worker may auto-resolve a stale alert when its condition no longer holds, so the active list reflects current truth.
- **Alert acknowledged while its condition persists**: dismissing an alert does **not** re-spam it — the worker treats an acknowledged (trip, case) as still occupying the slot and generates a fresh alert only after the condition clears and later recurs. *(Clarifications 2026-05-31c)*
- **Document/billing alert cases**: §17 cases 7–8 produce **no** alert until slices 008/009 supply their inputs (deferred, not silently dropped).

## Requirements *(mandatory)*

### Functional Requirements

**Execution events & timeline (EVT-001..EVT-005, §11.4, §13.7, §14.1; reuses 003)**

- **FR-001**: Authorized users (`update_trip_status`) MUST be able to record the standard execution milestones (**At Origin, Loading (optional), Loaded, In Transit/departed, At Destination, Unloading (optional), Unloaded**) as trip events; the optional **Loading/Unloading** sub-states (§12.1) are recorded as ordinary status transitions captured via the existing `status_change` event type (no new event-type member), so their time-in-status feeds FR-018. *(EVT-001, §11.4, §12.1)*
- **FR-002**: Every status change MUST be recorded **automatically** as a `trip_events` row capturing **timestamp, actor, source, and previous/new status**, without a separate user step. *(EVT-002)*
- **FR-003**: Milestone recording MUST be driven through **slice 003's existing `transitionTripStatus` service** (its concurrency guard, status machine, and audit write); this slice MUST NOT redefine the status machine and MUST extend the `trip_events` vocabulary only as needed (the single `note` member; the optional Loading/Unloading milestones reuse `status_change` per FR-001) and wire the `exception_id` FK by migration rather than recreating the table. *(§11.4, §12.1; reuses 003)*
- **FR-004**: Users MUST be able to add **free-form events with notes and attachments** (where attachment storage is available) that do not change trip status. *(EVT-003)*
- **FR-005**: The system MUST support **planned-vs-actual timestamp comparison** for milestones, using the planned pickup/delivery windows from import. *(EVT-004)*
- **FR-006**: The Trip-Detail **timeline** MUST display all trip events in **chronological order** and become **interactive** (milestone recording + note/attachment entry points), upgrading slice 005's read-only timeline. *(EVT-005, §15.5)*

**Exceptions (EXC-001..EXC-006, §11.5, §13.8, §14.1, §15.8)**

- **FR-007**: Authorized users (`create_exceptions`) MUST be able to **create an exception linked to a trip**. *(EXC-001)*
- **FR-008**: An exception MUST carry **category, reason code, severity, owner, status, responsible party, description, opened/resolved timestamps, closure notes, and attachments** (where supported). The **owner** MUST be a **required internal-user reference** that **defaults to the creating user** and is **reassignable** to any internal user. *(EXC-002, §14.1)*
- **FR-009**: The system MUST support exception **statuses Open, Monitoring, Resolved, and Cancelled** with these legal transitions: **Open↔Monitoring**; **Open→Resolved**, **Open→Cancelled**, **Monitoring→Resolved**, **Monitoring→Cancelled** (Monitoring is optional). **Resolved and Cancelled are terminal — they MUST NOT be reopened**; a recurrence is logged as a new exception. Resolution (by `resolve_exceptions` holders) MUST record **closure notes and a resolved timestamp**. *(EXC-003, §11.5)*
- **FR-010**: The system MUST support configurable **reason codes** covering at least: delay, no-show, vehicle breakdown, driver issue, customer delay, loading delay, unloading delay, documentation issue, accident, route deviation, cancellation, and other — each with a **default severity and default responsible party** that pre-fill but remain editable. *(EXC-004, §14.1)*
- **FR-011**: Users MUST be able to mark **responsible party** as customer-caused, Brazil Transports-caused, carrier-caused, **force majeure**, or unknown — a dedicated five-value set distinct from 003's four-value cancellation enum. *(EXC-005)*
- **FR-012**: Exception data MUST be available to **SLA, billing, and dispute reporting** (this slice provides the records and the SLA feed; billing/dispute consumption is owned by later slices). *(EXC-006)*
- **FR-013**: The **Exception Management** screen MUST list exceptions and filter by **severity, customer, lane, reason, owner, and age**, and the Trip-Detail exceptions section MUST fill slice 005's reserved placeholder. *(§15.8, §15.5)*

**SLA risk classification (SLA-001..SLA-004, CUST-005, §12.2, §13.10, §19.3)**

- **FR-014**: The system MUST compute a per-trip **SLA-risk state** of **On Track / At Risk / Late / Breached** and persist it server-side to the existing **`trips.sla_status`** column (kept as `text`, validated to the four values via Zod + a CHECK constraint — **no new enum**) together with a new **`trips.sla_reasons text[]`** column holding the contributing reasons, both written atomically. When multiple triggers fire, `sla_status` MUST be the **most severe** state by the ordering **On Track < At Risk < Late < Breached**, while `sla_reasons` retains **all** contributing reasons. The UI MUST NOT compute or override SLA classification. *(§12.2; STACK §6 — BFF/worker is SLA authority)*
- **FR-015**: SLA-risk evaluation MUST flag trips at risk due to **missing assignment, missed confirmation, delayed origin arrival, delayed loading, delayed departure, delayed destination arrival, or an open high-severity exception**, recording the contributing **reasons**, and MUST map each trigger to a state as: a **missed planned origin/destination arrival window ⇒ Late**; **missing assignment, missed confirmation, delayed loading, delayed departure, or an open high-severity exception ⇒ At Risk**; none fired ⇒ **On Track**. **Breached is not produced in MVP** — it requires a customer-supplied SLA threshold (gated §29 Input #2) and stays unset until per-customer thresholds are configured. *(SLA-003, §12.2)*
- **FR-016**: On-time **pickup** and **arrival** MUST be calculated from **per-customer pickup/delivery window rules**, falling back to **company defaults** where a customer rule is absent. *(SLA-001, SLA-002, CUST-005)*
- **FR-017**: Missing-assignment and missed-confirmation risk MUST read the **current assignment and confirmed-at state owned by slice 006** (read-only). *(SLA-003; reuses 006)*
- **FR-018**: Where **per-milestone planned times are unavailable** (loading, departure), risk MUST be derived from **time-in-status** against a configurable default threshold; because the optional Loading/Unloading sub-states are recordable (FR-001), this time-in-status is measurable from the recorded status entry. *(§12.2; §29 Input #2)*
- **FR-019**: `sla_status` MUST be recalculated **on relevant changes** (assignment, confirmation, milestone, exception) **and** by a **periodic worker sweep with a configurable default cadence of ~5 minutes** for time-based triggers (passed cutoffs, missed arrivals), with no dependency on Realtime. *(§12.2, STACK §3.10/§3.11)*
- **FR-020**: The Control-Tower board, the **"At risk"** view, Trip Detail, and the Home Dashboard **at-risk count** MUST surface SLA-risk state and reasons via **polling**, filling slice 005's reserved SLA indicators/view/row-indicator slots. *(SLA-003, SLA-004, §15.4/§15.5)*

**Per-customer SLA rules (CUST-005, §14.1, §29 Input #2)**

- **FR-021**: Authorized users (`manage_commercial_data`) MUST be able to manage **per-customer SLA rules**: pickup/delivery on-time definitions and tolerances, confirmation cutoff lead time, at-risk warning window, optional lane/vehicle-type scope, and effective dates. When a trip matches more than one rule, scope precedence is **lane > vehicle-type > customer-default**, tie-breaking on the latest `effective_start`; a rule outside its effective window is not selected (fall back to company defaults). *(CUST-005, §14.1)*
- **FR-022**: When a customer's SLA rules are **not supplied**, the system MUST evaluate on **explicit company defaults** AND report that customer's **final SLA sign-off as blocked** (never silently treat defaults as signed off). *(§29 Input #2; Constitution II)*

**In-app alerts (§17)**

- **FR-023**: The **worker** MUST generate **in-app alerts** for the in-scope §17 cases: (1) within window & still unassigned, (2) within window & not confirmed, (3) missed origin arrival, (4) missed departure, (5) missed destination arrival, (6) high-severity exception opened — using **fixed default time windows** for MVP. *(§17; STACK §3.11)*
- **FR-024**: Alert generation MUST guarantee **at most one alert per (trip, case) that is ACTIVE or ACKNOWLEDGED** (idempotency scoped to the not-yet-cleared state, not all-time); an **acknowledged** alert MUST NOT be regenerated while its condition still holds. When a condition clears, the worker MUST **auto-resolve** the active **or acknowledged** alert; if the condition **recurs later**, a **fresh** alert MUST be generated. Alerts MUST be **listable, countable, and acknowledgeable/dismissible** in-app. *(§17)*
- **FR-025**: Alerts MUST remain **in-app only**; the system MUST NOT send email, SMS, WhatsApp, webhook, or customer-portal notifications, and MUST NOT expose configurable external alert channels. *(§17 Later; scope boundary)*
- **FR-026**: §17 alert cases that depend on **documents (008)** or **billing (009)** — "completed but missing required documents" and "billing item blocked by missing proof" — MUST be **deferred** (the framework accepts them when those slices supply inputs), not invented from absent data. *(Constitution II)*

**Cross-cutting (auth, audit, i18n, freshness)**

- **FR-027**: All write surfaces MUST be **authorized in the BFF**: milestones/status via `update_trip_status`, exception create via `create_exceptions`, exception resolve via `resolve_exceptions`, SLA rules via `manage_commercial_data`; reads use `view_all_trips`. Alert acknowledgement/dismissal is a **read-surface triage** mutation authorized by `view_all_trips` (no write key). *(§16; reuses 001; first enforcement of the three exception/status keys)*
- **FR-028**: Exception lifecycle changes and manual milestone/status updates MUST produce **audit history** (reusing 001's audit foundation / 003's append-only `trip_events`). *(STACK §5.4)*
- **FR-029**: All new UI MUST render in **pt-BR** with i18n scaffolding; all timestamps stored in **UTC** and displayed in **America/São_Paulo**. *(STACK §3.1/§3.5)*
- **FR-030**: Freshness on every new surface (timeline, exceptions, SLA indicators, alerts) MUST be **polling via TanStack Query** — never Supabase Realtime. *(STACK §3.10)*

### Key Entities *(three new tables + an in-app alert store; `trip_events` and `trips.sla_status` reused)*

- **Trip Event** *(REUSED — owned by slice 003; PRD §14.1, §13.7)*: the append-only execution/audit log row — event **type** (the 003 enum, extended here), **status before/after**, **source**, **actor**, **event timestamp** (actual milestone time) + DB `created_at`, **location**, **notes**, and **`exception_id`** (forward hook whose FK 007 wires). This slice **writes** milestone/note/exception event rows and **reads** them as the chronological timeline; it never mutates or recreates the table (append-only, insert+select only).
- **Exception** *(NEW; PRD §14.1, §13.8)*: an operational issue linked to a trip — trip reference; **category**; **reason code** reference; **severity**; **owner** (required internal-user reference, defaults to creator, reassignable); **status** (Open/Monitoring/Resolved/Cancelled — Resolved/Cancelled terminal); **responsible party** (customer-caused / Brazil Transports-caused / carrier-caused / force majeure / unknown — its own five-value set); **description**; **opened timestamp**; **resolved timestamp**; **closure notes**; **attachments** (where supported). Feeds SLA-risk and downstream billing/dispute reporting.
- **Reason Code** *(NEW — config/master; PRD §14.1)*: a configurable exception classifier — **category** (the EXC-004 set), **label** (pt-BR), **default severity**, **default responsible party**, **active status**. One configurable set, not per-customer code (Constitution — config-driven variation). Distinct from 003's `cancellation_options`.
- **Customer SLA Rule** *(NEW; PRD §14.1, CUST-005)*: per-customer SLA parameters — customer reference; optional **scope** (lane or vehicle type); **pickup window rule** (on-time definition / tolerance); **delivery window rule**; **confirmation cutoff** (lead time before pickup); **at-risk warning window**; **effective start/end**; **active status**. Absence ⇒ company defaults + sign-off blocked.
- **In-App Alert** *(NEW; supports §17 — no PRD §14 entity, introduced as an informed default)*: a generated, in-app-only notice — trip reference; **case** (the §17 condition); **severity/kind**; **state (active / acknowledged / resolved)**; **created-at**; **acknowledged-by / acknowledged-at**; **auto-resolved-at** (when the condition clears). At most **one not-yet-cleared row per (trip, case)** — partial-unique across the **active OR acknowledged** state, so a dismissed-but-still-true alert is not re-spammed; the worker auto-resolves the active or acknowledged row when the condition clears, and a later recurrence generates a fresh alert. Not an external-channel notification.
- **Trip SLA-risk state** *(REUSED column `trips.sla_status` + NEW `trips.sla_reasons` column, computed here; PRD §12.2)*: the trip's current **SLA status** (On Track / At Risk / Late / Breached — stored as validated `text`, **no new enum**, set to the **most severe** fired state) in `trips.sla_status`, plus the set of **active risk reasons** in a new **`trips.sla_reasons text[]`** column; computed server-side and recalculated by BFF + worker. **Breached** is unreachable until per-customer thresholds are configured (§29 Input #2).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An authorized user can advance a confirmed trip through all execution milestones and the Trip-Detail timeline shows every event in chronological order with planned-vs-actual deltas. *(EVT-001..EVT-005, §23)*
- **SC-002**: 100% of status changes produce an automatic event capturing actor, source, timestamp, and previous/new status — with zero requiring a separate manual logging step. *(EVT-002)*
- **SC-003**: A user can create an exception, see reason-code defaults pre-fill, and move it Open→Monitoring→Resolved with closure notes and a resolved timestamp persisted. *(EXC-001..EXC-003)*
- **SC-004**: Exception Management lists exceptions and filters correctly by severity, customer, lane, reason, owner, and age. *(§15.8)*
- **SC-005**: For every one of the seven SLA-risk triggers, a trip in that condition is classified with the correct `sla_status` and reason **by the server** — per FR-015's trigger→state map (missed planned origin/destination arrival window ⇒ Late, the other five ⇒ At Risk), a trip firing several triggers shows the **most-severe** state with **all** reasons retained, and Breached is not produced in MVP — and the same result appears on the board, "At risk" view, and dashboard count. *(SLA-003, SLA-004)*
- **SC-006**: SLA risk updates without any user action when a time-based trigger fires (e.g., a confirmation cutoff passes), within the configured worker sweep cadence (~5 min default) plus immediate on-change recalc, surfaced via polling — with no Realtime dependency. *(§12.2, STACK §3.10/§3.11)*
- **SC-007**: The six in-scope §17 alert cases generate exactly one active in-app alert per (trip, case), are dismissible, and never trigger an external channel; the two document/billing cases produce no alert until 008/009 land. *(§17)*
- **SC-008**: A customer with configured SLA rules is evaluated against them; a customer without rules is evaluated against company defaults **and** is reported as SLA sign-off blocked. *(CUST-005, §29 Input #2)*
- **SC-009**: Every write surface refuses users lacking the required key (`update_trip_status` / `create_exceptions` / `resolve_exceptions` / `manage_commercial_data`) and all such changes appear in audit history. (Alert acknowledgement is view-surface triage tracked on the alert row — `acknowledged_by`/`acknowledged_at` — deliberately **not** an `audit_logs` action.) *(§16, STACK §5.4)*
- **SC-010**: At medium scale, the Exception Management list and the Control-Tower board / "At risk" view load within **~3 s**, and each ~5-min worker SLA sweep over the active-trip set (low-thousands, chunked ≤200/batch) completes well within its cadence — performance bars inherited from slice 005, verified by a manual spot-check via the per-sweep summary log. *(plan Performance Goals; §16, §19.3)*

## Traceability *(acceptance criteria → PRD)*

| Spec item | Maps to PRD ID / section | Notes |
|---|---|---|
| US1, FR-001, FR-003, SC-001 | **EVT-001**; §11.4, §13.7 | Record milestones |
| US1, FR-002, SC-002 | **EVT-002**; §13.7 | Auto status event |
| US1, FR-004, US1-AS6 | **EVT-003**; §13.7 | Notes/attachments |
| US1, FR-005, SC-001 | **EVT-004**; §12.2 | Planned-vs-actual |
| US1, FR-006, SC-001 | **EVT-005**; §13.7, §15.5 | Chronological/interactive timeline |
| US2, FR-007, SC-003 | **EXC-001**; §11.5, §13.8 | Create exception |
| US2, FR-008, SC-003 | **EXC-002**; §13.8, §14.1 | Exception fields |
| US2, FR-009, SC-003 | **EXC-003**; §13.8 | Status lifecycle |
| US2, FR-010 | **EXC-004**; §13.8, §14.1 | Reason codes |
| US2, FR-011 | **EXC-005**; §13.8 | Responsible party (incl. force majeure) |
| US2, FR-012 | **EXC-006**; §13.8 | Feeds SLA/billing/dispute |
| US2, FR-013, SC-004 | §15.8, §15.5 | Exception Management + detail section |
| US3, FR-014, FR-015, SC-005 | **SLA-003**; §12.2, §13.10 | Risk triggers → `sla_status` |
| US3, FR-016, SC-008 | **SLA-001, SLA-002, CUST-005**; §13.10 | On-time pickup/arrival |
| US3, FR-017 | **SLA-003**; §14.1 | Reads 006 assignment |
| US3, FR-018, FR-019, SC-006 | §12.2; §29 Input #2 | Time-in-status / recalc |
| US3, FR-020, SC-005 | **SLA-004**; §13.10, §15.4/§15.5 | Board/dashboard surfaces |
| US4, FR-023, FR-024, SC-007 | §17 (cases 1–6) | In-app alert generation |
| US4, FR-025, FR-026, SC-007 | §17 (Later); §22/§23 | In-app only; 7–8 deferred |
| US5, FR-021, FR-022, SC-008 | **CUST-005**; §14.1, §29 Input #2 | SLA rules + blocked sign-off |
| All write surfaces, FR-027, FR-028, SC-009 | §16; STACK §5.4 | Auth + audit |
| All UI, FR-029, FR-030 | STACK §3.1/§3.5/§3.10 | pt-BR/TZ/polling |
| SC-010 | §16, §19.3; plan Performance Goals | Perf bars inherited from 005 (list/board ~3 s; sweep within cadence) |
| Phase context / exit criteria | §22 (Phase 3); §23 | "Update statuses, log exceptions, at-risk indicators" |

## Scope

### In scope

- **Manual execution-milestone updates** and the **interactive trip timeline** (EVT-001..EVT-005), driven through 003's transition service; `trip_events` reused and its vocabulary extended.
- **Exception lifecycle** (EXC-001..EXC-006) and the **Exception Management** screen (§15.8), including configurable **reason codes**.
- **Server-authoritative SLA-risk classification** for the seven §13.10 triggers (SLA-001..SLA-004), computing **`trips.sla_status`**, with **per-customer SLA rules** (CUST-005) and company-default fallback.
- **In-app alert generation** (worker) for the six in-scope §17 cases, with idempotency and acknowledgement.
- Filling slice 005's reserved **timeline-interactivity, exception, and SLA-indicator** placeholders and the Home Dashboard **at-risk / active-exceptions / on-time** widgets.
- First enforcement of `update_trip_status`, `create_exceptions`, `resolve_exceptions`; reuse of `manage_commercial_data` for SLA rules.

### Out of scope (owned by later slices or post-MVP)

- **GPS-based events and geofence arrival/departure detection** (EVT-006/EVT-007, §20.2) — manual milestone updates only for MVP.
- **External notifications**: email, SMS, WhatsApp, webhooks, customer-portal, and configurable external alert channels (SLA-006/SLA-007, §17 Later).
- **Document requirements and proof** (slice 008) and **billing readiness/export** (slice 009) — including the two §17 alert cases that depend on them, and EXC-006's billing/dispute *consumption*.
- **SLA performance reporting** (SLA-005) beyond the live at-risk indicators — analytics dashboards are later.
- **Per-milestone planned times** and **per-customer alert thresholds** — deferred to business input (§29 Input #2) / post-MVP.
- **Escalation alerts by severity/age** (EXC-007, Later).

## Assumptions

- **`trip_events` reuse**: the table, its append-only REVOKE, and its `trip_event_type`/`trip_event_source` enums already exist (slice 003) and are explicitly meant to be **extended by 007**; the `exception_id` forward hook gets its FK here. This slice adds usage/migration, not a new event table. *(003 data-model)*
- **`trips.sla_status` reuse**: the column exists as a 003 placeholder "007 owns"; this slice computes/populates it (kept as validated `text`, **no new enum**) and **adds a sibling `trips.sla_reasons text[]` column** for the contributing reasons, written atomically with the status. *(003 data-model; Clarifications 2026-05-31c)*
- **Status machine reuse**: milestone updates are status transitions through 003's `transitionTripStatus` service; the status machine and concurrency guard are not redefined. *(§12.1)*
- **SLA inputs**: per-customer SLA rules are a gated business input (§29 Input #2). Default = **company-default rules + SLA sign-off blocked** per customer until supplied — configurable, not invented. *(Constitution II)*
- **Milestone-level risk**: loading/departure risk derived from **time-in-status** (configurable default), since per-milestone planned times are not yet provided; the optional Loading/Unloading statuses are now user-recordable (FR-001), so this time-in-status is measurable. *(§12.2)*
- **Alert windows**: MVP uses **fixed default time windows** for alert/at-risk timing; per-customer thresholds are post-MVP (SLA-006). *(§17)*
- **Alerts in-app only and persisted** as a lightweight store to enable listing/counting/acknowledgement and idempotent generation; no external delivery.
- **Severity scale**: a small fixed severity scale (e.g., low/medium/high) is assumed for exceptions, with **high** driving the high-severity SLA/alert trigger; labels are config, not invented per customer. *(EXC-002)*
- **Exception responsible-party set** is a dedicated five-value set (adds **force majeure** to 003's four-value cancellation enum), not a reuse of the cancellation enum. *(EXC-005 vs 003)*
- **Attachments**: exception/event attachments are supported only where the storage surface from a later slice (008) is available; absent that, attachments are deferred without blocking the lifecycle. *(EXC-002)*
- **Worker & queue**: SLA recalculation and alert generation run in the **single Node worker on the Postgres-backed queue** — no Redis/BullMQ, no Edge Functions. *(STACK §3.11)*

## Dependencies

- **Slice 001 (Platform, Access, App Shell)**: auth/session and BFF auth context; the code-defined permission catalog whose `update_trip_status`, `create_exceptions`, and `resolve_exceptions` keys this slice first enforces (and whose `manage_commercial_data` it reuses); the append-only audit-log foundation; i18n; the app shell the Exception Management screen mounts in.
- **Slice 002 (Master Data & Config)**: customers (for per-customer SLA rules and exception filtering) and the `manage_commercial_data` key reused for SLA-rule administration; master entities referenced by dispute context.
- **Slice 003 (Trip Domain & Lifecycle)**: the trip model, the **status machine**, the **`transitionTripStatus` service** (concurrency guard + audit), the append-only **`trip_events`** log (surfaced/extended here) with its `exception_id` forward hook, and the **`trips.sla_status`** placeholder column this slice computes.
- **Slice 005 (Control Tower — Read Models & Dashboards)**: the read-model framework, Control-Tower board, Trip-Detail shell (read-only timeline + exception/SLA placeholders), Home Dashboard, the extensible row-indicator/view framework, and the at-risk/exception/on-time widgets this slice fills.
- **Slice 006 (Dispatch Assignment)**: the **current assignment** and **confirmed-at** state read (read-only) to detect missing-assignment and missed-confirmation risk and the corresponding alerts.
- **Later — Slice 008 (Documents & Proof)** and **Slice 009 (Billing Readiness)**: supply inputs for the two deferred §17 alert cases, exception/event attachment storage, and EXC-006's billing/dispute consumption.

## Blocked / Open for business sign-off

Design decisions are resolved as informed defaults in **Clarifications**; the items below are **business-input or later-slice gaps**, each with an explicit default so the slice ships and is not blocked from building.

1. **Per-customer SLA rules** *(PRD §29 Input #2; CUST-005, SLA-001/002/003, §12.2; gates "SLA sign-off")* — **Open (business input).** Until Ops/Customers supply pickup/delivery on-time definitions, tolerances, and confirmation cutoffs, the evaluator runs on **company-default rules** and each affected customer is reported **SLA sign-off blocked**. Not a build blocker.
2. **Per-milestone planned times (loading, departure)** *(§12.2; §29 Input #2)* — **Open (business input).** Defaulted to **time-in-status** thresholds until supplied. Not a build blocker.
3. **Alert / at-risk time windows** *(§17; SLA-006)* — **Resolved default, post-MVP for configurability.** Fixed default windows now; per-customer thresholds deferred (SLA-006, Later).
4. **Document & billing alert cases** *(§17 cases 7–8; slices 008/009)* — **Deferred to later slices.** The alert framework accepts these cases; they emit nothing until 008/009 supply document-requirement and billing-proof state.
5. **Exception reason-code list** *(EXC-004; §14.1; 003 open item #2)* — **Resolved default.** Ships the EXC-004 category set as configurable seed data; the final production code list is config, sign-off deferred to business confirmation (mirrors 003's cancellation-reason gap).
6. **Exception severity scale & escalation** *(EXC-002; EXC-007 Later)* — **Resolved default.** Small fixed scale with **high** as the SLA/alert trigger; **severity/age-based escalation alerts (EXC-007) are Later**, not in this slice.
7. **Attachment storage** *(EXC-002; slice 008)* — **Deferred.** Exception/event attachments depend on the proof-storage surface (008); the lifecycle works without them until then.
