# Quickstart: Auto-Validate Imported Trips (slice 014)

How to verify the slice end-to-end. The whole point: **an imported trip is immediately assignable** — no
manual validation step, and the dispatch queue only ever offers trips that can actually be assigned.

## Setup

```powershell
# App DB on port 5433 (project convention). Seed master data + demo locations so import codes resolve.
pnpm --filter @brazil-tms/db db:seed:master-data
pnpm --filter @brazil-tms/db db:seed:locations      # origem/destino codes (UNKNOWN_LOCATION otherwise)
pnpm --filter @brazil-tms/db db:seed:resources      # demo drivers + vehicles + trailers (for assigning)
# (optional) reset accounts for e2e
pnpm --filter @brazil-tms/db db:seed:e2e
```

Start the app + worker (the worker MUST be running for parse/validate/confirm to advance — and
**restart it after editing the confirm-import worker**, or a stale process keeps the old behavior):

```powershell
pnpm --filter @brazil-tms/web dev      # Next.js BFF
pnpm --filter @brazil-tms/workers dev  # the single Node worker (pg-boss)
```

## Manual verification (the acceptance walk)

1. **Import → born validated (US1)** — Open `/imports`, pick a customer, upload a correctly formatted
   file (standard headers `id_viagem`, `origem`, `destino`, `janela_coleta_inicio/fim`,
   `janela_entrega_inicio/fim`, `tipo_veiculo`, `status`). Confirm the import. On the **Torre de
   Controle** (`/trips`) the created trips show status **"Validada"** (not "Recebida").
2. **Assign immediately (US1)** — Open **Expedição** (`/dispatch`). The imported trips appear in the
   **Fila de atribuição**. Pick driver + vehicle (+ carrier/trailer as needed) and click **Atribuir** →
   it **succeeds** (status → "Atribuída"); there is **no** "Operação não permitida para o status atual da
   viagem" error.
3. **Queue only offers assignable trips (US3)** — Any trip still in `received` (e.g. a manually created
   one, or a leftover from before this slice) does **NOT** appear in the Expedição queue — only
   unassigned **Validada** trips do.
4. **Update keeps status (US2)** — Assign one trip (now "Atribuída"). Re-import a file whose row matches
   that trip's customer + `id_viagem` with a changed window, and confirm. The trip's plan updates but its
   status **stays "Atribuída"** (it is NOT reverted to "Validada").
5. **Idempotent re-confirm** — Re-confirming the same batch creates no duplicate trips and does not change
   the status of already-applied trips.

## Automated tests

```powershell
# Worker integration — confirm-import: created trips are born "validated"; an update does NOT downgrade an
# existing assigned trip; a confirm-created trip assigns immediately (validated → assigned).
pnpm --filter @brazil-tms/workers test confirm

# (web integration, against the app DB on :5433 — DATABASE_URL set) createTrip default still "received"; explicit initialStatus honored.
pnpm exec vitest run --project web apps/web/lib/trips/trips-service.test.ts

# e2e (prod build, workers=1) — post-confirm trips show "Validada"; dispatch queue lists only validated
# (a seeded `received` trip is excluded); a freshly validated trip is assignable.
pnpm --filter @brazil-tms/web test:e2e -- trip-import
pnpm --filter @brazil-tms/web test:e2e -- dispatch-board
```

## Done / acceptance mapping

| Check | Spec |
|-------|------|
| Imported trips land `validated` (born validated, atomic) | FR-001, FR-004, SC-001 |
| Freshly imported trip assigns from Expedição with no error | US1 AC2, SC-002 |
| Both valid + warning rows → created trip is `validated` | FR-003, US1 AC3 |
| An `update` to an `assigned` trip keeps its status | FR-002, US2, SC-003 |
| Re-confirm: no extra transitions, no duplicates, no errors | FR-005, SC-004 |
| Dispatch queue lists only unassigned `validated` trips | FR-006, US3, SC-005 |
| Import validation/dedup/confirm/reasons unchanged | FR-007, SC-006 |
| No new table/column/enum/migration/permission/dependency | FR-008 |
| Auto-validate recorded as a labeled decision | FR-009 |
