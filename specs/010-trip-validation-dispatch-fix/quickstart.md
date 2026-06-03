# Quickstart — 010 Trip Validation Action & Dispatch Queue Hardening

How to set up, run, and verify this corrective slice. It builds on shipped slices 003/005/006 and adds nothing durable, so setup is the standard monorepo flow — no new env var, migration, or service.

## Prerequisites

- The standard local stack (self-hosted Supabase: Postgres + Auth + Storage) running per the repo README / slice-001 setup.
- `DATABASE_URL` set for integration/e2e (see the repo `.env` conventions).
- pnpm 10, Node 20.

```powershell
pnpm install
pnpm --filter @brazil-tms/db db:migrate    # no NEW migration in this slice; just ensure schema is current
pnpm --filter @brazil-tms/db db:seed             # accounts (admin)  — db:seed:e2e likewise seeds accounts only
pnpm --filter @brazil-tms/db db:seed:master-data # demo customer + locations
pnpm --filter @brazil-tms/db db:seed:trip-domain # demo trips: DEMO-TRIP-001 received · -002 validated · -003 assigned (advanced via the services)
pnpm --filter @brazil-tms/web dev           # http://localhost:3000
```

## Verify by user story

### US1 — Validate a received trip (P1)

1. Sign in as **Admin** (or Operations Manager / Dispatcher / Control Tower — any `update_trip_status` holder).
2. Open a trip in **`received`** (e.g. `DEMO-TRIP-001`) → **Trip Detail**.
3. Confirm a **Validar** action is shown (it is **not** shown for trips past `received`/`validation_error`).
4. Activate it → the trip becomes **`validated`**; the timeline/audit shows a `status_change` event attributed to you (source `operator_manual`).
5. Sign in as **Finance** (no `update_trip_status`) → open the same kind of trip → the **Validar** action is **not** available; a direct `POST /api/trips/:id/status` is refused `403`.
6. (Correction) Open a `validation_error` trip → the action offers **return to `received`**; activating it sets `received`.

### US2 — Dispatch queue lists only assignable trips (P1)

1. As a **Dispatcher**, open **Expedição** (Dispatch Board).
2. The "Fila de atribuição" lists **only `validated`, unassigned** trips — no `received`, no `in_transit`, no already-assigned trips.
3. Validate a `received` trip (US1) → it now appears in the queue.
4. Click **Atribuir** on a queued trip, pick driver + vehicle, submit → assignment **succeeds** and the trip leaves the queue.
5. If no trip is `validated`, the board shows the empty-state ("nothing to assign"), not an error.

### US3 — Clear message when a trip cannot be assigned (P2)

1. Attempt to assign a **`received`** trip directly (e.g. via the API, or a stale board row): the response is **`409 NOT_ASSIGNABLE`** and the UI shows **"A viagem precisa ser validada antes de ser atribuída."** — not the old "reassignment only" message; no assignment is created.
2. Repeat for an **`in_transit`** trip → same `NOT_ASSIGNABLE` outcome (the route handles all non-assignable statuses).
3. A **`validated`** trip still assigns; reassigning an **`assigned`**/**`confirmed`** trip still works (regression).

## Tests

```powershell
# Unit (web lib) — i18n guard (no dotted keys; NOT_ASSIGNABLE present)
$env:DATABASE_URL='...'; pnpm exec vitest run --project web apps/web/lib/messages.test.ts

# e2e (run against a prod build, single worker, e2e seed) — per repo convention
pnpm --filter @brazil-tms/db db:seed:e2e
pnpm --filter @brazil-tms/web build
pnpm --filter @brazil-tms/web test:e2e -- --workers=1 `
  apps/web/e2e/trip-validate.spec.ts `
  apps/web/e2e/dispatch-board.spec.ts `
  apps/web/e2e/dispatch-assignment.spec.ts
```

What the e2e specs assert:

- **trip-validate.spec.ts** (NEW): `received → validate → validated` through Trip Detail, with one `status_change` event + one audit record; `update_trip_status` holder `2xx` vs non-holder `403`; the action is not offered for a non-`received`/`validation_error` trip.
- **dispatch-board.spec.ts** (EXTEND): the queue contains only `validated`, unassigned trips (no `received`/`in_transit`/assigned); a queued trip assigns successfully.
- **dispatch-assignment.spec.ts** (EXTEND): assigning a `received` and an `in_transit` trip → `409 NOT_ASSIGNABLE` with the pt-BR message; `validated` assigns; reassign from `assigned`/`confirmed` still works.

> e2e gotchas (from prior slices): run against a **prod build** with `--workers=1`; reset accounts/data with **`db:seed:e2e`** (role-change specs otherwise pollute the seeded admin); a stale `next dev` can hold broken HMR state for edited cross-package routes — use a fresh build before trusting e2e.

## Definition of done

- All seven Constitution Check items pass (see `plan.md`); schema diff shows **zero** durable additions.
- SC-001…SC-007 (`spec.md`) verified; issue #11 reproduction no longer reproduces.
- Lint + typecheck + build + the tests above are green; PR opened against **`dev`** with the PR template. AI does **not** merge to `main`.
