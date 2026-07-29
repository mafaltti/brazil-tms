# Quickstart — Trip Cancellation in Control Tower and Dispatch (017)

**Spec**: [spec.md](./spec.md) · **Contracts**: [contracts/trip-cancellation-api.md](./contracts/trip-cancellation-api.md)

## Setup (Windows dev machine, no Docker)

```powershell
# 1. Portable Postgres 16 (port 5433) — required by db-backed suites
& 'C:\Users\brazil\.local\pg16\pgsql\bin\pg_ctl.exe' start -D C:\Users\brazil\.local\pg16\data -l C:\Users\brazil\.local\pg16\pg.log -o "-p 5433"
$env:DATABASE_URL = 'postgres://postgres:postgres@localhost:5433/postgres'

# 2. Install + seed (adds the default cancellation reasons; billing impacts already present)
pnpm install
pnpm --filter @brazil-tms/db db:seed:trip-domain   # idempotent per (kind, code)

# 3. Quality gates (all must pass before PR)
pnpm lint && pnpm typecheck && pnpm build && pnpm test
```

> Full browser login (GoTrue/Storage) needs the Docker stack and does not run on this machine —
> UI verification beyond Playwright's seeded e2e accounts follows the 016 precedent (manual pass on
> an environment with the auth stack).

## Manual verification script

1. **Seed check**: `SELECT kind, code, label_pt, active FROM cancellation_options ORDER BY kind, sort_order;`
   → 6 active `reason` rows + 3 active `billing_impact` rows.
2. **Cancel from Trip Detail (US1)** — as **operations_manager**: open a `received` trip → header
   shows "Cancelar viagem" → dialog: motivo, parte responsável, impacto de faturamento (all
   required) → confirm → status badge "Cancelada"; timeline gains the status event; audit history
   shows "Viagem cancelada" with the inputs; SLA risk cleared.
3. **Missing element (FR-006)**: submit the dialog without responsible party → inline pt-BR error,
   trip unchanged.
4. **Dispatch row (US2)** — as **dispatcher**: queue row → "Cancelar" → same flow → row leaves the
   queue on next poll (≤30 s).
5. **Control Tower row (US3)**: cancel from the list row → row shows "Cancelada" after refetch;
   default active view excludes it.
6. **Dispatcher limit (FR-007)**: as dispatcher, open an `in_transit` trip detail → no cancel
   action; `POST /api/trips/{id}/cancel` directly → 409 `NOT_CANCELLABLE_BY_ROLE`. Same trip as
   ops_manager → cancel succeeds.
7. **Role without permission**: as **control_tower**, no cancel affordance anywhere; direct POST →
   403.
8. **Loophole closed (FR-008)**: `POST /api/trips/{id}/status` with `{"toStatus":"cancelled"}` (any
   authorized role) → 409 `USE_CANCELLATION_ENDPOINT`.
9. **Not configured (FR-011)**: `UPDATE cancellation_options SET active=false WHERE kind='reason';`
   → dialog shows the "não configurado" state; POST → 409 `CANCELLATION_NOT_CONFIGURED`; reactivate.
10. **Terminal statuses**: a `completed`/`billed`/`cancelled` trip offers no cancel action; direct
    POST → 409 `NOT_CANCELLABLE`.

## Test suites touched

- `packages/shared/src/domain/trip-status.test.ts` — `DISPATCH_PHASE_TRIP_STATUSES` shape.
- `apps/web/lib/trips/trip-cancellation.test.ts` — `allowedSourceStatuses` acceptance/refusal
  (`NOT_CANCELLABLE_BY_ROLE`), existing cases untouched.
- New route/integration coverage for `/cancel`, `/cancellation-options`, and the `/status` refusal.
- Playwright: cancel flow on the three surfaces; permission matrix rows (dispatcher limited,
  control_tower denied); `permission-coverage.spec.ts` note at lines 16-17 finally realized.
