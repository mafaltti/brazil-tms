# Implementation Plan: Validation-Error Reject Action

**Branch**: `010-trip-validation-dispatch-fix` (folded into PR #13) | **Date**: 2026-06-02 | **Spec**: [spec.md](./spec.md)

## Summary

Add the operator **reject** transition `received → validation_error` ("Marcar erro de validação") with a required reason, completing the validate/reject pair slice 010 began. It is a **UI-only** change: it **extends slice 010's `ValidateAction` component** to offer, for a `received` trip, both *Validar viagem* (→ validated) and *Marcar erro de validação* (→ validation_error). The reject reuses the **existing** `POST /api/trips/:id/status` endpoint via the existing `useRecordMilestone` hook; the legal edge already exists; the **reason** rides the **existing optional `notes`** field that `transitionTripStatus` already persists on the append-only `trip_events` `status_change` row and audits. **Zero durable additions** (no table/enum/migration/permission key/package/dependency/worker/endpoint/service).

## Technical Context

**Language/Version**: TypeScript 5.6 (strict); Next.js 15 / React 19; next-intl (pt-BR); TanStack Query 5; shadcn/ui (Button, Textarea, Card). **No new runtime deps.**

**Storage**: **No schema change.** Reuses the `received → validation_error` legal edge and the existing `trip_events.notes` column. No migration.

**Testing**: Vitest (`messages.test.ts` — assert the new reject keys) + Playwright (`trip-validate.spec.ts` — a reject test: `received → validation_error` with the reason persisted on the event; the slice-010 correction test stays).

**Project Type**: Web app — existing monorepo. **No new package/worker/permission key.**

**Constraints**: BFF-only authz (`update_trip_status`, reused); status authority server-side; polling only; pt-BR; reason is client-required (`notes` stays optional server-side).

**Scale/Scope**: **1** UI component edit (`validate-action.tsx`), **1** i18n edit (`pt-BR.json` — 4 reject keys + hint), **1** unit-test edit, **1** e2e test added, **2 languages** of guide updates. **0** backend / shared / db changes.

## Constitution Check

Confirmed against `.specify/memory/constitution.md` (v1.0.0):

- [x] **Simplicity (I)**: A button + a reason textarea calling an existing endpoint; reuses the existing `notes` field for the reason. No new key/endpoint/service/table/enum/migration/dep/worker; no new abstraction.
- [x] **Scope (II)**: Completes the slice-010 pair; the automatic import-time validator is explicitly deferred (not invented).
- [x] **System-of-record (III)**: Reject flows through the single `transitionTripStatus` service (guarded transition + append-only `trip_events` with the reason + audit + SLA recompute); the status machine is not redefined; no parallel write path.
- [x] **Authz & secrets (IV)**: Reuses `update_trip_status` (BFF-enforced); the action is hidden client-side for non-holders.
- [x] **Config over code (V)**: No customer-specific behavior; no invented criteria.
- [x] **Tech constraints**: Polling only; no Realtime/Edge/Redis/microservice/optimizer.
- [x] **Workflow**: Lands on the `010-…` branch → PR to `dev`; CI gates green; AI does not merge to `main`.

**Result: PASS.** Complexity Tracking empty.

### Post-Design re-check

Still PASS — the reject reuses the existing endpoint/service/permission/`notes` field; nothing durable added.

## Project Structure (source)

```text
apps/web/components/trips/trip-detail/validate-action.tsx   # EXTEND: add reject (received→validation_error) + reason textarea
apps/web/messages/pt-BR.json                                # EXTEND: rejectAction/rejectReason*/updated validateHint (Trips.detail)
apps/web/lib/messages.test.ts                               # EXTEND: assert the reject keys
apps/web/e2e/trip-validate.spec.ts                          # EXTEND: reject test (received→validation_error, reason on event)
docs/USER-GUIDE.html                                        # EXTEND (EN+PT): document the reject action; fix the "auto-fails" wording
```

**Structure Decision**: Pure UI extension of slice 010's component on the same Trip Detail surface; no backend touched. Folded into PR #13 because it depends on slice 010's unmerged component.

## Complexity Tracking

No violations. The reject is the minimal completion of a half-shipped pair, reusing the existing endpoint/service/permission/`notes` field. Intentionally empty.
