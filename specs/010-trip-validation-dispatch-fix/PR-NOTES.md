# PR Notes — 010 Trip Validation Action & Dispatch Queue Hardening

**Closes #11.** A corrective close-out slice over shipped slices 003/005/006. PR base: **`dev`** (AI must not merge to `main`).

## What & why

An imported/created trip is always created in `received`, but no shipped UI advanced it to `validated`, so it could never be assigned — and the Dispatch Board listed non-assignable trips that failed with a misleading `ILLEGAL_TRANSITION`. This slice:

- **(US1) Validate action** — a new `validate-action.tsx` on Trip Detail (shown only for `received`/`validation_error`) performs `received → validated` (and the `validation_error → received` correction) via the **existing** `POST /api/trips/:id/status` endpoint and the reused `useRecordMilestone` hook. Source `operator_manual` (audit fidelity).
- **(US2) Dispatch queue** — `dispatch-board.tsx` `DISPATCH_QUERY` narrowed `scope=active` → `status=validated&assigned=false`. No read-model change (the `status` filter already existed).
- **(US3) Assignment error** — `assignment/route.ts` now branches explicitly; any non-assignable status returns `Conflict("NOT_ASSIGNABLE", …)` (409) instead of being misrouted into the reassign path. Wired into `assignment-form.tsx` `ERROR_CODES` + a `Dispatch.errors.NOT_ASSIGNABLE` pt-BR label.
- **(Seed)** `trip-domain-sample.ts` (demo `db:seed:trip-domain`) now seeds `received` + `validated` + `assigned` demo trips, advanced **through the services** (never a raw `UPDATE`).

## Principles applied

- **I (KISS/DRY/YAGNI)**: reuses the existing endpoint/service/hook/permission; one new small component, one route branch, one error string. No new abstraction. Auto-validate-on-import deliberately **not** built.
- **III (System-of-record)**: validate flows through the single `transitionTripStatus` (append-only `trip_events` + `audit_logs` + SLA recompute); the status machine is not redefined; the seed advances via services.
- **IV (Authz)**: validate reuses `update_trip_status` (BFF-enforced); the UI also hides the action for non-holders via `can(role, "update_trip_status")`.
- **Adds NOTHING durable**: no new table, enum, migration, permission key, package, worker, or runtime dependency.

## Deviations from the original tasks (all surfaced by `/speckit-analyze`)

1. **Seed wiring (finding M1)** — the e2e do **not** use `db:seed:e2e` for trips (it seeds accounts only); the Playwright specs **self-seed**. The new `trip-validate.spec.ts` and the extended dispatch specs self-seed; the `trip-domain-sample.ts` refresh is demo-only. Tasks T003 / research R8 / quickstart corrected.
2. **Client permission gate (SC-003)** — to make the Validate button truly *not rendered* for non-holders, `viewerRole` is threaded from the server page into `ValidateAction` (`can(role, "update_trip_status")`). Small, local; the BFF still enforces.
3. **Canonical `NOT_ASSIGNABLE` string (finding I1)** — the route `Conflict` message and the `Dispatch.errors.NOT_ASSIGNABLE` label use the **same** pt-BR string ("A viagem precisa ser validada antes de ser atribuída.").

## How tested

- `pnpm -r typecheck` — **pass** (all 4 projects).
- `pnpm --filter @brazil-tms/web --filter @brazil-tms/db lint` — **pass** (no warnings/errors).
- `pnpm exec vitest run --project web apps/web/lib/messages.test.ts` — **pass** (14 tests; +2 for `NOT_ASSIGNABLE` + the validate keys).
- `pnpm --filter @brazil-tms/web build` — **pass**.
- **e2e** (`trip-validate.spec.ts` new; `dispatch-board.spec.ts` + `dispatch-assignment.spec.ts` extended): authored + typecheck-clean; run against a **prod build**, `--workers=1`, after `db:seed:e2e` — **not run in CI sandbox** (needs a live Supabase stack); run locally before merge.
- Schema/permissions diff (SC-007 / INV-5): no migration/table/enum/permission-key changes.
