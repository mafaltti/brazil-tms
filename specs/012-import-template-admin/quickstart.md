# Quickstart: Import Template Administration

How to seed, run, demo, and test feature 012. **No migration** is needed (data-model delta = NONE).

## Prerequisites

- Local Supabase/Postgres up; `DATABASE_URL` set (see the Supabase local-stack notes).
- App deps installed (`pnpm install`).

## Seed (so there's a customer + an existing template to work with)

Order matters — master data first (creates the `DEMO-SHOPEE` customer), then the demo template:

```powershell
pnpm --filter @brazil-tms/db db:seed              # admin user (login)
pnpm --filter @brazil-tms/db db:seed:master-data  # DEMO-SHOPEE customer + locations
pnpm --filter @brazil-tms/db db:seed:import       # 1 demo template (so the list isn't empty)
```

## Run

```powershell
pnpm dev    # http://localhost:3000
```

Sign in as an Admin or Operations Manager (the only roles holding `import_trips`).

## Demo flow (maps to the user stories)

1. **Reach the screen**: Administration → **Modelos de Importação** (`/admin/import-templates`), or the
   **"Gerenciar modelos"** link on `/imports`.
2. **US1 — create**: select the **Shopee (Demo)** customer → "Novo modelo" → fill name, version, file
   type, add ≥1 column mapping (pick a target from the grouped picker — note the four pt-BR groups:
   Texto / Data e Hora / Número / Estruturado), set parsing rules (defaults pre-filled) → **Salvar**.
   Then open `/imports`, select the same customer → the new template appears in the **Modelo** selector.
3. **US2 — edit / version / duplicate**: edit a template's mapping and save; use **"Criar nova versão"**
   (form opens pre-filled, version = max+1); try saving a `(customer, name, version)` that already exists →
   the pt-BR message **"Já existe um modelo com esse nome e versão."** appears (not a generic error).
4. **US3 — lifecycle**: deactivate a template → it disappears from the `/imports` selector; reactivate →
   it returns; archive one (toggle **"Incluir arquivados"** to see it) → it shows **no Edit action**;
   deactivating/archiving a customer's **last active** template shows the pt-BR warning and lets you
   **Prosseguir**.
5. **Footgun checks**: mapping the **same target twice** blocks save with an inline hint; mapping a date
   field with **no date format** shows a non-blocking warning.

## Test

```powershell
# Unit (pure helpers + i18n key guard) — web Vitest scans apps/web/lib/** only
pnpm exec vitest run --project web apps/web/lib/imports/import-templates-form.test.ts
pnpm exec vitest run --project web apps/web/lib/messages.test.ts

# Permission matrix (import_trips = Admin + Operations Manager)
pnpm exec vitest run packages/shared/src/auth/permissions.test.ts

# E2E (flows + authz + rendered pt-BR) — run against a fresh build, workers=1
pnpm --filter @brazil-tms/web test:e2e -- import-template-admin
```

**E2E notes**: authenticate via the existing login/apiLogin helper. The **403/redirect** authorization
case uses a role that **lacks** `import_trips` — e.g. **Dispatcher** (or Finance / Control Tower). Isolate
by using unique template names (timestamped) rather than DB cleanup; don't assume the seeded template's
exact mapping count — fetch and inspect it.

## Acceptance check (Definition of Done for the slice)

- All FR-001…FR-017 demonstrable in the UI; spec Success Criteria SC-001…SC-008 hold.
- `lint`, `typecheck`, `build`, Vitest, and the new Playwright spec are green.
- **No** file changed under `packages/db`, `packages/shared`, `workers/`, or any migration directory
  (verify the diff) — the slice is UI + i18n + tests only.
- Real per-customer template **content** remains labeled BLOCKED on §29 Input #1 (not signed off here).
