# Quickstart: Collapse Validation Statuses into "Recebida" (slice 015)

How to build, migrate, and verify the collapse. App DB runs on **port 5433**; Windows + PowerShell host.
The pg-boss worker must be **restarted** after editing `confirm-import` (a stale/duplicate worker can keep
birthing trips at the old status — MEMORY `stale_duplicate_worker_masks_fix`).

## 0. Branch

```powershell
git rev-parse --abbrev-ref HEAD   # expect 015-collapse-validation-statuses (off dev)
```

## 1. Apply the migration (born + backfill)

```powershell
# scaffold the data-only migration (no schema diff), then it is hand-filled with the two UPDATEs
pnpm --filter @brazil-tms/db exec drizzle-kit generate --custom --name=collapse_validation_statuses
# (fill 0008_*.sql with the backfill — see data-model.md §3 — then:)
pnpm --filter @brazil-tms/db db:migrate
```

Verify no live trip remains in a dormant status:

```sql
-- expect 0 rows
SELECT current_status, count(*) FROM trips
 WHERE current_status IN ('validated','validation_error') GROUP BY 1;
SELECT count(*) FROM trips WHERE disputed_from_status IN ('validated','validation_error');  -- expect 0
-- history is intentionally preserved (may be > 0):
SELECT count(*) FROM trip_events WHERE status_after IN ('validated','validation_error');
```

## 2. Static checks (the type system is the safety net)

```powershell
pnpm -w lint
pnpm -w typecheck      # any leftover "validated"/"validation_error" TS literal now fails here
pnpm -w build          # next build catches route-export / render issues tsc misses
```

Expected: `TripStatus` is 16 values; every stale literal surfaces as a non-overlapping-comparison or
excess-key error. Plain strings in `DISPATCH_QUERY`, `pt-BR.json`, and Playwright matchers are **not**
caught by tsc — they are covered by §4/§5.

## 3. Unit / integration (Vitest)

```powershell
# shared machine
pnpm --filter @brazil-tms/shared exec vitest run src/domain/trip-status.test.ts
#   expect: TRIP_STATUSES length 16; ACTIVE 10; received→assigned legal; assigned→received legal;
#           assigned→confirmed still legal; partition 10+6=16.

# db/web integration (run from repo root with DATABASE_URL set; see MEMORY web_vitest_run_command)
pnpm exec vitest run --project web `
  apps/web/lib/trips/trip-assignments.test.ts `
  apps/web/lib/trips/trip-unassign.test.ts `
  apps/web/lib/trips/trip-transitions.test.ts `
  apps/web/lib/trips/trips-service.test.ts        # born-validated test is DELETED; default stays received

# worker
pnpm --filter @brazil-tms/workers exec vitest run jobs/confirm-import/confirm.test.ts
#   expect: confirm-created trips are "received" and assign immediately (received→assigned);
#           batch.status assertions still "validated" (import_batch_status — unchanged).
```

## 4. E2E (Playwright, prod build, `--workers=1`, fresh DB)

Reset accounts/data first (MEMORY `e2e_local_admin_ui_failures`): `pnpm --filter @brazil-tms/db db:seed:e2e`.

```powershell
pnpm --filter @brazil-tms/web exec playwright test `
  e2e/dispatch-board.spec.ts `        # INVERTED: a received trip is now INCLUDED in the queue
  e2e/dispatch-assignment.spec.ts `   # assign from received; the confirm test still passes (confirm retained)
  e2e/trip-import.spec.ts `           # INVERTED: post-confirm badge reads "Recebida" (not "Validada")
  e2e/trip-lifecycle.spec.ts          # born Recebida → assign → CONFIRM step still present → execution
```

## 5. Manual smoke (the user's scenario)

1. **Import → Recebida → assign (US1)**: `/imports` → upload + confirm a standard batch. Open `/dispatch`
   (Expedição): the new trips appear as **"Recebida"** with an "Atribuir" action. Assign one → it becomes
   **"Atribuída"** with no `ILLEGAL_TRANSITION` and **no "Validar" step**.
2. **Confirm still works (FR-007)**: on the "Atribuída" trip, the **"Confirmar atribuição"** button is still
   present → click it → trip becomes **"Confirmada"** → execution milestones proceed as before.
3. **Unassign → Recebida (US2)**: on an "Atribuída" trip, "Remover atribuição" → dialog reads "…voltará para
   **Recebida**" → confirm → trip is **"Recebida"** again and reappears in the dispatch queue.
4. **No removed labels (FR-009)**: nowhere in status badges, the `/trips` filter chips, the dispatch queue,
   dialogs, or the trip inspector does **"Validada"** or **"Erro de validação"** appear. (The `/imports`
   screen still shows the import **batch** "Validado" — that is a different concept and is expected.)
5. **Legacy rows (US3)**: any pre-existing trip that was "Validada"/"Erro de validação" now shows
   **"Recebida"**, renders with a proper badge, and is dispatchable.

## 6. Worker restart reminder

After editing `workers/jobs/confirm-import/index.ts`, **restart the worker** and prove the running one via a
live enqueue. The `trip.create` audit `newValue.currentStatus` is the tell — it must read `received`. A
stale/duplicate worker grabbing the confirm job will keep birthing `validated` trips and mask the fix.

## Definition of done

- [ ] `pnpm -w lint && pnpm -w typecheck && pnpm -w build` green.
- [ ] Vitest (shared/db/web/worker) green; born-validated test removed; inverted assertions updated.
- [ ] Playwright dispatch/import/lifecycle green (inversions correct).
- [ ] Migration 0008 applied; 0 live trips in dormant statuses; `trip_events` history preserved.
- [ ] Manual smoke (§5) passes; no "Validada"/"Erro de validação" visible anywhere; confirm step intact.
- [ ] `docs/PRD.md` §12/§12.1/§30 (+ workflow prose) amended; PR targets `dev`.
