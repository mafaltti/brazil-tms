---

description: "Task list for 011 — Validation-Error Reject Action"
---

# Tasks: Validation-Error Reject Action

**Input**: Design documents from `/specs/011-validation-error-reject/`

**Prerequisites**: plan.md ✅, spec.md ✅. Builds on slice 010 (same branch / PR #13).

**Tests**: INCLUDED (e2e reject + the messages i18n guard). UI-only slice; no backend/db change.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: User Story 1 — Reject a received trip (Priority: P1) 🎯

**Goal**: An operator can move a `received` trip to `validation_error` with a required reason, from Trip Detail, reusing the existing `/status` endpoint + `update_trip_status`.

**Independent test**: As an `update_trip_status` holder, reject a `received` trip with a reason → `validation_error` + one append-only `status_change` event carrying the reason in `notes` + audit; reject disabled without a reason; not offered to non-holders / non-`received` trips.

- [X] T001 [US1] e2e test in `apps/web/e2e/trip-validate.spec.ts`: reject a `received` trip via `POST /status` (`toStatus: validation_error`, `notes: reason`) → `200` + `validation_error`; assert exactly one `trip_events` `status_change` row with `notes = reason` and `source = operator_manual`. (Correction test `validation_error → received` already present.)
- [X] T002 [US1] Extend `apps/web/components/trips/trip-detail/validate-action.tsx`: for a `received` trip render a reason `Textarea` + a **"Marcar erro de validação"** button alongside **"Validar viagem"**; the reject calls `useRecordMilestone` with `{expectedFromStatus, toStatus:"validation_error", source:"operator_manual", notes: reason}` and is disabled until a reason is typed. Keep the `validation_error → received` correction branch.
- [X] T003 [US1] Add the `Trips.detail` i18n keys to `apps/web/messages/pt-BR.json` (`rejectAction`, `rejectReasonLabel`, `rejectReasonPlaceholder`, `rejectReasonRequired`) and update `validateHint` to mention the reject option. Flat keys (no dots).

**Checkpoint**: A `received` trip can be validated OR rejected (with a reason) from the UI.

---

## Phase 2: Docs & Guards

- [X] T004 Extend `apps/web/lib/messages.test.ts` to assert the four new reject keys exist under `Trips.detail`.
- [X] T005 Update `docs/USER-GUIDE.html` (EN + PT-BR): document the **Marcar erro de validação** reject action (received→validation_error, with a reason, who can do it) in the dispatch "validate first" callout; note in the `validation_error` status-table row that it is set by the operator's reject action (not automatically) — which also tightens the earlier "if validation fails…" wording.
- [X] T006 Verify: `pnpm -r typecheck`, lint (web), `messages.test.ts`, `next build`, and the `trip-validate.spec.ts` e2e (against a prod build + `db:seed:e2e`). Confirm an empty schema/permissions diff (SC-004).

---

## Dependencies

- T001 (test) → T002/T003 (impl) → T004 (guard) → T006 (verify). T005 (docs) is independent. The reject and validate share `pt-BR.json` (T003) — no conflict within the slice.
- Depends on slice 010's `ValidateAction` + `viewerRole` wiring (same branch).

## Notes

- Reuses the existing `/status` endpoint, `update_trip_status` permission, and the `trip_events.notes` field for the reason — **zero durable additions** (verify with T006).
- Reason is client-required; `transitionTripSchema.notes` stays optional server-side (a direct API reject without a reason is accepted by design).
- Lands on the `010-trip-validation-dispatch-fix` branch (PR #13); AI does not merge to `main`.
