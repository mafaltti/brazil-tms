# Research & Design Decisions — 010 Trip Validation Action & Dispatch Queue Hardening

Phase 0 of `/speckit-plan`. Each decision is grounded in the issue-#11 root-cause analysis (verified against the current code) and the constitution. Format: **Decision / Rationale / Alternatives rejected**. No NEEDS CLARIFICATION remain.

## R1 — Where does the Validate action live?

**Decision**: A new, small **`ValidateAction` component on the Trip Detail screen** (slice 005), rendered only when `trip.currentStatus ∈ {received, validation_error}`. It is **not** added to the dispatch board, the assignment panel, or the execution timeline's milestone recorder.

**Rationale**: Trip Detail is where a `received` trip is inspected and where today it has **no actionable control** (`AssignmentPanel` renders the assign form only for `validated`/`assigned`/`confirmed` — `assignment-panel.tsx:19,32`; the timeline's `MILESTONE_STATUSES` excludes `validated` — `timeline.tsx:29`, so `nextStatuses` is empty for a `received` trip and no button shows). A dedicated component keeps the **lifecycle action (003)** cleanly separated from the **execution milestones (007)** and the **assignment surface (006)**, each owned elsewhere. Surfacing it on Trip Detail (not the board) also matches the per-trip "ready this trip" mental model and avoids widening the dispatch board's responsibility.

**Alternatives rejected**: (a) Extend the timeline's milestone recorder to include `validated` — wrong: muddies "execution milestone" semantics and would also surface `validation_error`/`cancelled` if `MILESTONE_STATUSES` were naïvely widened. (b) Put it in the `AssignmentPanel` — that panel is 006/Dispatch-namespaced; a pre-dispatch lifecycle action does not belong there. (c) A board-row "Validate" action — deferred (Future Enhancements); MVP surfaces it where the trip is inspected.

## R2 — New client hook, or reuse the existing status mutation?

**Decision**: **Reuse the existing `useRecordMilestone(id)` hook** (`apps/web/lib/trips/client.ts:254`) — it is the generic `POST /api/trips/:id/status` mutation (it posts `{expectedFromStatus, toStatus, source, eventTimestamp}` and invalidates the `["trips"]` root). No new hook, no new endpoint.

**Rationale**: DRY (Constitution I) — the hook is already the single client for the status endpoint despite its 007-era name; adding a `useValidateTrip` would be a near-duplicate below the ≥3 abstraction threshold. The Validate component calls it with `{expectedFromStatus: trip.currentStatus, toStatus: "validated", source: "operator_manual"}` (and `toStatus: "received"` for the `validation_error` correction).

**Alternatives rejected**: A dedicated `useValidateTrip`/`useTransitionTripStatus` hook (unnecessary duplication); renaming `useRecordMilestone` (touches 007's timeline for no functional gain — larger diff).

## R3 — Manual operator action vs automatic validation on import

**Decision**: **Manual operator action only.** Auto-validation on import success is **out of scope** for this slice.

**Rationale**: Slice 004 explicitly does not transition trips (`confirm-import/index.ts:26`), and PRD §12.1's note makes **Warning** a flag on a Received/Validated trip that "requires user attention but does not block progression" — i.e. the PRD intends a **human review beat** between Received and Validated. Auto-promotion would erase that beat. KISS/YAGNI: the explicit action is the smallest change that unblocks the flow. (Adversarially confirmed in the issue-#11 analysis: §12.1's Warning semantics actively argue against auto-validate.)

**Alternatives rejected**: Auto-validate in `confirm-import` (erases the review beat; contradicts 004's documented invariant; would require routing through `transitionTripStatus` per trip anyway) — recorded as a deferred Future Enhancement.

## R4 — New `validate_trip` permission key?

**Decision**: **No new key.** Reuse the existing **`update_trip_status`** key (`packages/shared/src/auth/permissions.ts`).

**Rationale**: `update_trip_status` already gates the `POST /status` route that performs the transition, and its holders (Admin, Operations Manager, Dispatcher, Control Tower) are a **superset** of the §12.1 owner "System validation / Operations". Adding a key would violate Constitution I/IV (new key requires justification) for no benefit. Mirrors how prior slices reused pre-declared keys (006 reused `assign_resources`).

**Alternatives rejected**: A dedicated `validate_trip` key (unjustified; finer-grained gating is YAGNI at MVP).

## R5 — What status set should the Dispatch Board queue show?

**Decision**: **`status=validated&assigned=false`** — only `validated`, unassigned trips. **Not** `validated,assigned,confirmed`.

**Rationale**: The board queue already pins `assigned=false` (`trips-read.ts:386` → `isNull(boardAsg.id)`), which **already excludes** `assigned`/`confirmed` trips (they always have a current assignment row). `validated` is the only status assignable **from this queue** (`assignTrip` requires `validated` — `trip-assignments.ts:387-394`). **Reassignment is initiated elsewhere** (the Trip Detail `AssignmentPanel`; the Control-Tower quick-assign which is itself `validated`-only — `control-tower-table.tsx:195`), never from the board queue (the board passes `currentAssignment={null}` — `dispatch-board.tsx:102`). So narrowing to `validated` loses **no** reassignment flow and removes only non-actionable noise (`received`, `validation_error`, and in-flight statuses). Adding `assigned,confirmed` would be redundant (filtered out by `assigned=false`) and misleading.

**Implementation note**: The board read model needs **no code change** — `trip-board.ts` already accepts `status` as `oneOrMany(z.enum(TRIP_STATUSES))`, and `trips-read.ts:341-343,356-361` applies an explicit `status` list and suppresses the `scope=active` default when `status` is present. Only the client constant `DISPATCH_QUERY` (`dispatch-board.tsx:30`) and its doc comment change.

**Alternatives rejected**: Keep `scope=active` (the bug); `status=validated,assigned,confirmed` (redundant + reintroduces non-queue-actionable rows). Editing `trips-read.ts` (unnecessary — capability already exists).

## R6 — Shape of the assignment-route fix

**Decision**: Replace the client-driven ternary `expectedFromStatus === "validated" ? assignTrip : reassignTrip` with an **explicit by-status branch**:

- `validated` → `assignTrip`
- `assigned` | `confirmed` → `reassignTrip`
- **else → `throw new Conflict("NOT_ASSIGNABLE", "A viagem precisa ser validada antes da atribuição.")`**

Keep `reassignTrip`'s own up-front guard (`trip-assignments.ts:471-476`) as server-authoritative defense-in-depth.

**Rationale**: This stops the silent misroute of **all** non-assignable statuses (not only `received`) into the reassignment path, and returns an honest, accurate result. It is **defense-in-depth**: after R5 narrows the queue, a non-assignable trip should not normally reach the route, but a stale board row or a direct API call still gets the right answer. `Conflict` maps to **409** carrying the code via `handleRouteError` (`route.ts:44`). The route keeps `expectedFromStatus` as the optimistic-concurrency token the services already use; it does **not** add a trip read to "derive the operation from the real status" (that would duplicate the services' own status pins — `assignTrip` hardcodes `WHERE current_status='validated'` and ignores the client token; there is no reassign-from-`validated` flow to regress).

**Alternatives rejected**: (a) Only change the pt-BR string for `ILLEGAL_TRANSITION` (cosmetic; still misroutes; ambiguous because `ILLEGAL_TRANSITION` is reused elsewhere). (b) Read the trip in the route to derive assign-vs-reassign (extra read; duplicates the services' status pins; no concurrency benefit).

## R7 — Wiring the new `NOT_ASSIGNABLE` code end-to-end

**Decision**: (1) `new Conflict("NOT_ASSIGNABLE", …)` in the route (the `Conflict` class takes a **free-form string code** — `packages/db/src/errors.ts` — so **no error-code union/type change** is needed). (2) Add `"NOT_ASSIGNABLE"` to the `ERROR_CODES` allowlist in `assignment-form.tsx:51-59` (else `mapError` degrades it to `REQUEST_FAILED`). (3) Add `Dispatch.errors.NOT_ASSIGNABLE` to `pt-BR.json` (next to the existing `ILLEGAL_TRANSITION`/`STALE_TRANSITION` at ~line 1316-1322). (4) Update the `assignment/route.ts` docstring's Conflict-code list.

**Rationale**: Matches the existing error-mapping contract exactly (`mapError` builds `errors.${code}`; codes not in the allowlist silently fall back). pt-BR-only (there is **no** `en.json` in the repo). Avoids next-intl `INVALID_KEY` (no dotted key — `NOT_ASSIGNABLE` sits flat under the `Dispatch.errors` object).

**Alternatives rejected**: Reusing `ILLEGAL_TRANSITION` (ambiguous, already means "reassignment only"); a typed error-code enum (no such union exists; YAGNI).

## R8 — Seed refresh

**Decision**: Extend `packages/db/seed/trip-domain-sample.ts` to advance **one demo trip to `validated`** and **one to `assigned`**, each **through the existing services** (`transitionTripStatus` for `received → validated`; `assignTrip` for `validated → assigned`), keeping at least one trip in `received` so the Validate action is demonstrable.

**Rationale**: After R5 the dispatch queue shows only `validated` unassigned trips; with the current seed (every trip `received`) the queue would be **empty**, making the board look broken in demo/e2e. Seeding through the services (never a raw `UPDATE`) preserves Constitution III (status machine + append-only history are the single write path) and gives the e2e specs real data. (Note: the 009 permission-coverage e2e uses fake IDs and does **not** depend on this seed. **Corrected during `/implement` (analyze finding M1):** `db:seed:e2e` seeds **accounts only**, so the dispatch/validate Playwright specs **self-seed** their own trip rows via `@brazil-tms/db`; this `trip-domain-sample.ts` refresh serves the **demo** `db:seed:trip-domain` path only.)

**Alternatives rejected**: Raw `UPDATE currentStatus='validated'` in the seed (violates III — skips `trip_events`/audit/SLA); leaving the seed unchanged (empties the hardened queue in demo/e2e).

## R9 — Include the `validation_error → received` correction?

**Decision**: **Yes** — the same `ValidateAction` component offers the `validation_error → received` correction (a legal edge — `trip-status.ts:85`) so a trip flagged in error can be returned for re-validation.

**Rationale**: Cheap (same component, same endpoint, same hook), and closes the same orphaned-transition gap symmetrically — a `validation_error` trip otherwise also has no UI control. Low risk, high coherence.

**Alternatives rejected**: Ship only `received → validated` (leaves `validation_error` trips equally stuck for negligible savings).

## R10 — Data-model / migration impact

**Decision**: **None.** No new table, column, enum, or migration. The contingent `0008`-style index migration is **not** needed (the hardened query is narrower and uses existing indexes).

**Rationale**: All edges exercised (`received → validated`, `validation_error → received`, `validated → assigned`) are already legal in `trip_status`; `trip_events`/`audit_logs` already record status changes. Constitution I/III: add nothing durable.

**Alternatives rejected**: Any schema/index change (unnecessary at MVP volume; the narrower query only reduces work).

## R11 — Audit fidelity (the `source` field)

**Decision**: The Validate action records the transition with **`source: "operator_manual"`** (matching the timeline's milestone recorder — `timeline.tsx:92`), not the service default `"system"`.

**Rationale**: §21.5 auditability — history must distinguish an **operator** promotion from an automated/system change. `transitionTripStatus` already writes a `trip_events` `status_change` row + an `audit_logs` `trip.status_change` record atomically; passing the explicit source keeps the trail accurate.

**Alternatives rejected**: Letting `source` default to `"system"` (mislabels an operator action in the audit trail).
