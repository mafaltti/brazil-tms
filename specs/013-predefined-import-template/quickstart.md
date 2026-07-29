# Quickstart: Predefined Import Template (slice 013)

How to verify the slice end-to-end. The whole point: **a customer with no configured template can import**
— so the key setup is to NOT run the per-customer import seed.

## Setup

```powershell
# App DB on port 5433 (see project conventions). Seed master data ONLY — do NOT run db:seed:import,
# so the target customer has zero import templates (proves the predefined path).
pnpm --filter @brazil-tms/db db:seed:master-data
# (optional) reset accounts for e2e
pnpm --filter @brazil-tms/db db:seed:e2e
```

Start the app + worker (the worker must be running for parse/validate/confirm to advance):

```powershell
pnpm --filter @brazil-tms/web dev      # Next.js BFF
pnpm --filter @brazil-tms/workers dev  # the single Node worker (pg-boss)
```

## Manual verification (the acceptance walk)

1. **No template step (US1)** — Open `/imports`. Confirm there is **no "Modelo" control** — only
   **Cliente** and **Arquivo**. Select any customer (one **without** a configured template).
2. **Provisional banner (US2)** — Confirm a visible pt-BR banner is present at the top of the screen
   stating the standard format is provisional/pending customer confirmation.
3. **CSV import** — Upload a correctly formatted file using the standard headers (`id_viagem`, `origem`,
   `destino`, `janela_coleta_inicio/fim`, `janela_entrega_inicio/fim`, `tipo_veiculo`, `status`) — e.g.
   `packages/db/seed/fixtures/import-clean.csv`. Expect: the batch advances to **validated** and the
   preview shows mapped rows (no "Nenhum modelo…" failure). Click **Confirmar** → trips are created and
   land in `received`.
4. **XLSX import** — Re-save the same data as `.xlsx` and upload. Expect identical mapping/preview — the
   parser is chosen by the `.xlsx` extension, not a template (US1 AC2).
5. **Wrong-format file (US3)** — Upload a file whose columns do **not** match (e.g.
   `import-errors.csv`, or a file with unrelated headers). Expect: every data row shows the existing
   per-row reasons ("identificador externo obrigatório", "local de origem não informado") in the preview
   and in the downloadable error report — **no** "wrong format" header message, and **no** unexplained
   "Falhou".
6. **Empty / header-only file** — Upload a file with only a header row. Expect: an **empty preview**
   (zero data rows), no per-row reasons (R8).
7. **Status warning is non-blocking** — For a customer **without** seeded `status_mappings`, a row with a
   `status` value shows an `UNMAPPED_STATUS` **warning** but still confirms into `received` (SC-003 =
   "reaches a confirmable preview", not "zero warnings").

## Automated tests

```powershell
# Shared unit — STANDARD_IMPORT_TEMPLATE parses against templateConfigSchema; inferFileType cases.
pnpm --filter @brazil-tms/shared test

# Worker unit — parse uses the constant when batch.templateId is null; XLSX picked by extension.
pnpm --filter @brazil-tms/workers test parse

# Web integration — i18n: Imports.provisionalNotice present; template/selectTemplate/noTemplates gone; no dotted keys.
pnpm exec vitest run --project web apps/web/lib/messages.test.ts

# e2e (prod build, workers=1) — import flow has no template step; banner visible; import succeeds with no
# template; wrong-format file shows per-row reasons.
pnpm --filter @brazil-tms/web test:e2e -- trip-import
```

## Done / acceptance mapping

| Check | Spec |
|-------|------|
| No template control; Cliente + Arquivo only | FR-001, SC-001 |
| Standard format applied for any customer, CSV + XLSX | FR-002/003/004, SC-003 |
| No "no template selected" failure | FR-005, SC-002 |
| Wrong-format → per-row reasons, no header message, no silent fail | FR-006, SC-004 |
| Provisional banner visible | FR-007, SC-005 |
| Validate/dedup/confirm/status unchanged; trips land in `received` | FR-008, SC-006 |
| `import_trips` reused; no new permission | FR-009 |
| Real-format swap = single object edit | FR-010, SC-007 |
| Template table/API retained (dormant); dead control/strings pruned | FR-011, FR-012 |
