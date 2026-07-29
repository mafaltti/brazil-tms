# Quickstart — 016 Freight Rate Lookup

## Prereqs

Stack up per `specs/015-collapse-validation-statuses/TESTING.md` (docker compose,
migrations, seeds). Then apply migration 0009:

```powershell
pnpm --filter @brazil-tms/db db:migrate
```

Worker is NOT needed for this feature (sync import).

## Manual verification (uses the REAL sheet — never commit it)

1. `pnpm dev` → login as Admin (or a Finance seed user).
2. Sidebar shows **Tabela de Fretes** → open. Empty state + upload button
   (Admin/Finance only — check a dispatcher seed user sees search only).
3. Upload `FRETES AGREGADOS - BRAZIL TRANSPORTS.xlsx` (kept outside the repo).
   Expect a pt-BR summary with the route/rate counts.
4. Spot-check: filter one UF Origem; check the Cidade combobox only offers that
   UF's cities; check one known route shows Km, Valor Ida/Reversa and Observações
   exactly as in the sheet; prices formatted `R$ 1.234,56`, missing values as "—".
5. Price filter: set a min/max; rows without Valor Ida disappear; clear filters.
6. Sort by Valor Ida and by Km; missing values go last.
7. Re-upload an edited copy (change one price): table reflects ONLY the new file
   (in ≤ 30 s on an already-open tab, without reload — FR-008).
8. Upload a broken copy (rename a header cell): 409 with row/column errors in
   pt-BR; data unchanged.
9. `/admin/audit`: entry `freight_rate_import / replace` with file name and counts.

## Automated

```powershell
pnpm test            # shared normalizer units run without DB
$env:DATABASE_URL="postgres://postgres:<pwd>@localhost:5433/postgres"
pnpm exec vitest run --project web   # service integration (skipIf without env)
pnpm test:e2e        # freight-rates.spec.ts (synthetic fixture)
pnpm lint; pnpm typecheck; pnpm build
```
