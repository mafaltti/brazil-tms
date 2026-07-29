---

description: "Task list for slice 017 — Trip Cancellation in Control Tower and Dispatch"
---

# Tasks: Trip Cancellation in Control Tower and Dispatch

**Input**: Design documents from `specs/017-trip-cancellation/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/trip-cancellation-api.md, quickstart.md

**Tests**: the slice-003 service tests stay green untouched; new coverage = the `allowedSourceStatuses`
option, both new routes, the `/status` refusal, and Playwright flows on the three surfaces (the
constitution mandates status-transition + permission coverage).

**Organization**: by user story (US1 Trip Detail, US2 Dispatch row, US3 Control Tower row) after a
Foundational phase that builds the entire server side + the shared dialog — each story phase then only
wires one surface.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: different file, no dependency on an incomplete task → parallelizable
- **[Story]**: US1 / US2 / US3 (Setup/Foundational/Polish carry no story label)

## ⚠️ Three traps that apply to EVERY task

1. **`/api/reason-codes` serves EXCEPTION reason codes** (007, table `reason_codes`) — a different
   domain from `cancellation_options` (003). Never reuse or extend it; the new
   `GET /api/cancellation-options` is a separate route over a separate table.
2. **`disputed` is OUT OF SCOPE on `/status`** — the FR-008 refusal covers `toStatus:"cancelled"`
   ONLY. Do not "fix" the disputed target while there; dispute entry belongs to 008/009.
3. **The BFF ignores client `cancellationTimestamp`** (FR-005) — the route forwards only
   `{reasonCode, responsibleParty, billingImpact}`; `cancelled_at` is server `now()`. Do not plumb a
   timestamp field into the dialog.

---

## Phase 1: Setup

- [X] T001 Confirm branch `017-trip-cancellation` (off `dev`) is checked out; start the portable
      Postgres (quickstart §Setup) and capture a baseline `pnpm -w lint && pnpm -w typecheck`
      (expected green pre-change) from the repo root.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the whole server side (constant, domain option, seed, routes, hooks) plus the shared
dialog — after this phase the API is fully cancellable and every story phase is a thin wiring step.

**⚠️ CRITICAL**: No user-story work before this phase completes.

- [X] T002 Edit `packages/shared/src/domain/trip-status.ts`: add
      `export const DISPATCH_PHASE_TRIP_STATUSES = ["received", "assigned", "confirmed"] as const satisfies readonly TripStatus[];`
      with JSDoc naming the §18 Dispatcher-"Limited" decision (clarification 2026-07-27, spec FR-007).
      `TRIP_STATUSES`/`TRANSITIONS` untouched.
- [X] T003 [P] Edit `packages/shared/src/domain/trip-status.test.ts`: membership/shape test for the
      new constant (⊂ `TRIP_STATUSES`, exact 3 members, all pre-execution).
- [X] T004 Edit `packages/db/src/trips/trip-cancellation.ts`: (a) `cancelTrip(tripId, input,
      actorUserId, opts?: { allowedSourceStatuses?: readonly TripStatus[] })` — after the row load,
      when the list is present and `row.currentStatus` is outside it, throw
      `Conflict("NOT_CANCELLABLE_BY_ROLE", "Seu perfil só pode cancelar viagens na fase de expedição.")`
      (before the `canTransition` check; race-safe via the existing optimistic guarded update);
      (b) add `queryCancellationOptions()` — active rows, ordered `kind, sort_order`, returning
      `{ kind, code, labelPt, sortOrder }`; (c) update the header doc (017 exposure).
- [X] T005 [P] Edit `packages/db/seed/trip-domain-sample.ts`: seed `kind='reason'` rows
      (`cancelled_by_customer` "Cancelado pelo cliente" 1, `no_vehicle_available` "Sem veículo
      disponível" 2, `no_driver_available` "Sem motorista disponível" 3, `weather_road`
      "Clima/estrada" 4, `documentation_issue` "Problema de documentação" 5, `other` "Outro" 6),
      idempotent per `(kind, code)` exactly like the billing block; update the header comment + log
      line ("reason codes seeded with 017 defaults — business sign-off pending", FR-013).
- [X] T006 [P] Edit `apps/web/lib/trips/trip-cancellation.ts`: re-export `queryCancellationOptions`
      alongside `cancelTrip`.
- [X] T007 Create `apps/web/app/api/trips/[id]/cancel/route.ts` (NEW): `POST` — `requireAuth()` +
      `requirePermission(ctx, "cancel_trip")`; parse body with `cancelTripSchema` then forward ONLY
      `{reasonCode, responsibleParty, billingImpact}` (trap 3); when `ctx.role === "dispatcher"`
      pass `{ allowedSourceStatuses: DISPATCH_PHASE_TRIP_STATUSES }`; respond `{ item }` (TripDetail);
      `export const dynamic = "force-dynamic"`; JSDoc per contract §1 (error table incl.
      `NOT_CANCELLABLE_BY_ROLE`).
- [X] T008 [P] Create `apps/web/app/api/cancellation-options/route.ts` (NEW): `GET` — `requireAuth()`
      + `requirePermission(ctx, "cancel_trip")`; `{ items: await queryCancellationOptions() }`;
      `force-dynamic`; JSDoc per contract §2 (pattern: `app/api/reason-codes/route.ts`, but the
      cancellation table — trap 1).
- [X] T009 [P] Edit `apps/web/app/api/trips/[id]/status/route.ts`: before the assignment-phase check,
      refuse `input.toStatus === "cancelled"` with `Conflict("USE_CANCELLATION_ENDPOINT",
      "Cancelamento não permitido por esta rota; use o endpoint de cancelamento.")`; extend the route
      JSDoc (the 409 list + why — FR-008); `disputed` untouched (trap 2).
- [X] T010 Edit `apps/web/lib/trips/client.ts`: add `useCancellationOptions()` (GET
      `/api/cancellation-options`, config-grade staleness) and `useCancelTrip(tripId)` (POST
      `/api/trips/${id}/cancel`, body `{reasonCode, responsibleParty, billingImpact}`, on success
      invalidate the `["trips"]` root) following the `useAssignTrip`/`useMarkCompleted` pattern.
- [X] T011 [P] Edit `apps/web/messages/pt-BR.json`: add the cancel-dialog keys under `Trips` (e.g.
      `cancelAction` "Cancelar viagem", `cancelTitle`, `cancelReasonLabel` "Motivo",
      `cancelResponsibleLabel` "Parte responsável", `cancelBillingLabel` "Impacto de faturamento",
      `cancelConfirm` "Cancelar viagem", `cancelKeep` "Voltar", `cancelNotConfigured` "Motivos de
      cancelamento não configurados. Contate um administrador.", responsible-party option labels
      `customer_caused` "Cliente", `brazil_transports_caused` "Brazil Transports", `carrier_caused`
      "Transportadora", `unknown` "Desconhecida"). `AuditActions.trip_cancel` already exists — do not
      duplicate.
- [X] T012 Create `apps/web/components/trips/cancel-trip-dialog.tsx` (NEW): shared shadcn/ui dialog —
      selects for motivo (options `kind==="reason"`), parte responsável
      (`CANCELLATION_RESPONSIBLE_PARTIES` + T011 labels), impacto (`kind==="billing_impact"`); all
      three required with inline errors (FR-006); `cancelNotConfigured` empty state when a kind has
      no active rows (FR-011); confirm → `useCancelTrip`; surface 409 messages from the BFF; house
      dialog/form patterns (cf. `dispatch/assignment-form.tsx`).
- [X] T013 Edit `apps/web/lib/trips/trip-cancellation.test.ts`: new cases — `allowedSourceStatuses:
      DISPATCH_PHASE_TRIP_STATUSES` succeeds on a `received`/`confirmed` trip; throws
      `NOT_CANCELLABLE_BY_ROLE` on an `in_transit` trip (which cancels fine WITHOUT the option);
      `queryCancellationOptions` returns active rows ordered and omits inactive. Existing cases
      untouched.

**Checkpoint**: `POST /api/trips/:id/cancel` works end-to-end via HTTP (all roles/errors per
contract); options endpoint serves the seeded lists; dialog component exists (not yet mounted).

---

## Phase 3: User Story 1 - Cancel from Trip Detail (Priority: P1) 🎯 MVP

**Goal**: an authorized user cancels a trip from the Trip Detail header with full §19.5
justification; timeline + audit show it; unauthorized/ineligible users see no action.

**Independent Test**: quickstart §2-§3 (ops_manager cancels a `received` trip from detail; missing
responsible party is rejected inline).

- [X] T014 [US1] Edit `apps/web/app/(shell)/trips/[id]/page.tsx`: compute `cancelScope` from
      `ctx.role` (`admin`/`operations_manager` → `"any"`; `dispatcher` → `"dispatch_phase"`; else
      `"none"`) and pass it to the detail client.
- [X] T015 [US1] Edit `apps/web/components/trips/trip-detail/trip-detail-client.tsx`: mount
      `CancelTripDialog` + a header-area "Cancelar viagem" (destructive variant) action; visible iff
      `cancelScope === "any" || (cancelScope === "dispatch_phase" &&
      DISPATCH_PHASE_TRIP_STATUSES.includes(currentStatus))`, AND
      `canTransition(currentStatus, "cancelled")`; on success the detail re-renders from the
      returned/refetched data (badge "Cancelada", SLA cleared, timeline + audit rows visible).
- [X] T016 [US1] Create `apps/web/e2e/trip-cancellation.spec.ts` (NEW) — US1 block: ops_manager
      cancels a `received` trip from detail (badge "Cancelada"; timeline event; audit "Viagem
      cancelada"); submit missing parte responsável → inline error, status unchanged; control_tower
      sees no action and direct `POST /cancel` → 403; dispatcher on an `in_transit` trip sees no
      action and direct POST → 409 `NOT_CANCELLABLE_BY_ROLE`; any role `POST /status
      {"toStatus":"cancelled"}` → 409 `USE_CANCELLATION_ENDPOINT` (FR-008); a `completed` trip
      offers no action and POST → 409 `NOT_CANCELLABLE`.

**Checkpoint**: issue #24's core is resolved — justified cancellation live on Trip Detail.

---

## Phase 4: User Story 2 - Cancel from the Dispatch board (Priority: P2)

**Goal**: dispatcher cancels a dead trip straight from the Expedição queue row; the row leaves the
queue on the next poll.

**Independent Test**: quickstart §4.

- [X] T017 [US2] Edit `apps/web/app/(shell)/dispatch/page.tsx`: compute `cancelScope` (same mapping
      as T014) and pass to the board.
- [X] T018 [US2] Edit `apps/web/components/trips/dispatch/dispatch-board.tsx`: per-row "Cancelar"
      action beside "Atribuir" opening the shared dialog (queue rows are `received` ⊂ dispatch
      phase, so any `cancelScope !== "none"` shows it); on success the `["trips"]` invalidation
      refreshes the queue; update the board JSDoc.
- [X] T019 [US2] Extend `apps/web/e2e/trip-cancellation.spec.ts` — US2 block: dispatcher cancels a
      queue trip from the row (full dialog flow) → row gone after refetch; a user with
      `assign_resources` but not `cancel_trip` (fleet_coordinator) sees "Atribuir" but no "Cancelar".

**Checkpoint**: Expedição cancels in place.

---

## Phase 5: User Story 3 - Cancel from the Control Tower list (Priority: P3)

**Goal**: cancel directly from a Control Tower table row.

**Independent Test**: quickstart §5.

- [X] T020 [US3] Edit `apps/web/app/(shell)/trips/page.tsx`: compute `cancelScope` (same mapping)
      and pass to the table.
- [X] T021 [US3] Edit `apps/web/components/trips/control-tower-table.tsx`: per-row cancel action
      beside quick-assign opening the shared dialog; visibility = same rule as T015 (per-row status);
      update comments.
- [X] T022 [US3] Extend `apps/web/e2e/trip-cancellation.spec.ts` — US3 block: admin cancels from a
      list row → row badge "Cancelada" after refetch and excluded from the default active view;
      control_tower sees no row action.

**Checkpoint**: all three surfaces live.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T023 [P] Edit `apps/web/e2e/permission-coverage.spec.ts`: add the `cancel_trip` matrix rows —
      POST `/cancel` 403 for control_tower/fleet_coordinator/finance; 200/409-domain (never 403) for
      admin/operations_manager/dispatcher — realizing the note at lines 16-17; update that comment to
      point at the dedicated endpoint.
- [X] T024 [P] Amend `docs/PRD.md` §30 (decision log): entry dated 2026-07-27 — Dispatcher §18
      "Limited" (Cancel trip) = dispatch-phase source statuses (`received|assigned|confirmed`),
      enforced at the cancellation endpoint; default cancellation-reason seed shipped as labeled
      scaffolding (billing impacts already present), business sign-off pending; `cancelled`
      unreachable via the generic status route (dedicated-endpoint rule).
- [X] T025 Run static gates from repo root: `pnpm -w lint && pnpm -w typecheck && pnpm -w build`.
- [X] T026 Run Vitest per quickstart (shared `trip-status.test.ts`; `apps/web/lib/trips/
      trip-cancellation.test.ts`; the untouched transition/assignment suites stay green) with
      `DATABASE_URL` on the portable Postgres.
- [X] T027 Run Playwright: done 2026-07-27 against the prod build + a local mock-GoTrue stack
      (`C:\Users\brazil\.local\brazil-tms-dev\` — no Docker on this machine): `trip-cancellation.spec.ts`
      **10/10 passed**, `permission-coverage.spec.ts` **31/31 passed** (incl. the 2 new `cancel_trip`
      rows). Two spec-side fixes were needed (refusal tests must use REAL option codes — the service
      validates options before the status/role guards).
- [X] T028 (POL) Quickstart pass §1-§10 done 2026-07-27 on the same local stack: all steps verified
      via e2e + Vitest + visual screenshots (detail button, dialog, dispatch row, FR-011
      "não configurado" state with deactivate→reactivate). Caveat: step 7's `control_tower` role has
      no seeded account anywhere — its denial is enforced by the same `can()` grant list (no
      `cancel_trip`) and covered by the finance/fleet-coordinator negatives; a full-Docker-stack pass
      remains possible but adds no new coverage beyond Storage-dependent flows (not touched here).

---

## Dependencies & Execution Order

- **Setup (P1)** → **Foundational (P2)** blocks all stories. Inside Foundational: T002 → {T003, T004,
  T007}; T004 → {T006, T007, T013}; T005 independent; {T007, T008} → T010 → T012 (dialog needs both
  hooks); T011 → T012. T009 independent of the rest (own file).
- **US1 (P3) / US2 (P4) / US3 (P5)** are mutually independent after Foundational — deliver in
  priority order; each is one page-prop edit + one surface edit + e2e.
- **Polish (P6)**: T023/T024 parallel anytime after Foundational; T025 → T026 → T027 are the final
  sequential gates after ALL story phases; T028 is the out-of-repo POL tail.
- **File coordination**: T014/T020 and T015/T021 touch different files; the three e2e tasks
  (T016/T019/T022) extend the SAME spec file — sequential. `client.ts` is touched only by T010.

## Parallel Opportunities

- Foundational: after T002+T004 land → T003, T005, T006, T008, T009, T011 all in parallel; then
  T007 → T010 → T012; T013 alongside T010/T012.
- Story phases: US1/US2/US3 wiring tasks touch disjoint files and could interleave, but the shared
  e2e file keeps test tasks sequential.
- Polish: T023, T024 in parallel; gates sequential.

## Implementation Strategy

- **MVP = Foundational + US1**: the API + Trip Detail flow resolves issue #24's core. Validate
  (T025-T026 + US1 e2e) before wiring the other two surfaces.
- **Single developer**: T001 → T028 in order; `[P]` marks safe parallelism.
- Commit per task or logical group; PR targets `dev` (never `main`).

## Notes

- The three traps at the top apply to every task — especially trap 1 (two "reason" tables).
- The dialog surfaces BFF pt-BR error messages as-is; only `cancelNotConfigured` gets a bespoke
  friendly state (FR-011).
- No schema change: if `drizzle-kit` reports a diff at any point, something went wrong — stop.
- Worker untouched; no restart needed (unlike 015).
