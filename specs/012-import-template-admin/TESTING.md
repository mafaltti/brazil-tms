# Feature 012 — Self-test guide (Import Template Administration)

How to stand up the local stack and exercise the in-app **Import Templates** screen: create, edit,
version, activate/deactivate, and archive a customer's import templates, and watch them appear in (or
disappear from) the **Trip Import** "Modelo" selector. This completes **CUST-003** — the half that
Feature 004 shipped only as a BFF API + worker, never a user-facing screen. Host: Windows + PowerShell.
Prereqs: Docker Desktop running, Node 20+/pnpm, `pnpm install` already done. This slice builds on the
**004** Import Template entity + config-driven engine + template endpoints + the Trip Import screen, and
**001**'s `import_trips` permission + Administration shell.

What's different from earlier slices:

- **This is a UI-only slice. Data-model delta = NONE.** It adds **no** migration, table, column, enum,
  permission key, worker job, package, or env var. `db:migrate` is still needed for a fresh DB, but it
  adds **nothing** for 012 — the screen reuses the **frozen** `import_templates` table, the
  `templateConfigSchema` contract, the `MAPPED_*_FIELDS` recognized-target sets, the `import_trips`
  permission, and the existing endpoints `GET/POST /api/import-templates` + `GET/PATCH
  /api/import-templates/:id` unchanged.
- **You do NOT need the worker** for the admin screen. All template CRUD goes through the BFF
  (`apps/web`). The worker (parse/validate/confirm) is only needed if you want to demonstrate the
  **full author→upload→trips chain** end-to-end (SC-005, the optional §5.6) — everything else works with
  **the app alone**.
- **Two rules the backend does NOT enforce are client-side** (verify them in the UI): no duplicate
  `target` across mapping rows (**blocking**) and a date-target-without-date-format **non-blocking**
  warning; plus **archived = read-only** and the **last-active** warn-and-allow confirm.
- The per-row **"Obrigatório"** checkbox is projected into the template's `requiredOverrides` on save —
  that's the only required-field set the import worker enforces (it does not read
  `columnMappings[].required`).
- Freshness is **polling** (TanStack Query, ~30 s) — no Realtime. A mutation invalidates the
  `['import-templates', …]` query key, which the Trip Import selector shares, so both refresh.

> Your local `.env` files already exist (gitignored): `infra/supabase/.env`, `apps/web/.env.local`,
> `packages/db/.env`, `workers/.env`. **012 adds no env var.**

## 1. Bring it up

```powershell
docker compose -f infra/supabase/docker-compose.yml up -d   # Postgres + GoTrue + gateway + Storage + Mailpit
# Wait until GoTrue is healthy:
curl http://localhost:8000/auth/v1/health                   # -> HTTP 200 {"name":"GoTrue",...}

pnpm --filter @brazil-tms/db db:migrate                     # all migrations 001→latest; 012 adds NONE
pnpm --filter @brazil-tms/db db:seed:e2e                    # role accounts (table in §2)
pnpm --filter @brazil-tms/db db:seed:master-data            # customer "Shopee (Demo)" (DEMO-SHOPEE) + locations
# db:seed:import is OPTIONAL — see the note below.
```

> **About `db:seed:import`** — it seeds **one** template ("Padrão Shopee (scaffolding)") for DEMO-SHOPEE.
> The whole point of 012 is that a customer can start with **no** template and you author one in-app, so:
>
> - **Skip it** to exercise the core story (SC-001/SC-005): a customer shows the empty state, you create
>   a template, and it then becomes selectable on Trip Import.
> - **Run it** (`pnpm --filter @brazil-tms/db db:seed:import`) if you'd rather have an existing template
>   to **edit / version** immediately (§5.2) without creating one first. It's idempotent.

**Run the app** (this is all you need for §5.0–§5.5):

```powershell
# Terminal A — app (BFF + the Import Templates screen) on http://localhost:3000
pnpm --filter @brazil-tms/web dev
```

**Optional — only for the full author→upload→trips chain (§5.6):**

```powershell
# Terminal B — the import worker (parse/validate/confirm). Not needed for the admin screen itself.
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
pnpm --filter @brazil-tms/workers start
```

- Host port 5432 taken? `SUPABASE_DB_PORT=5433` is already set in `infra/supabase/.env`.
- Mailpit (part of the stack, unrelated to 012): **http://localhost:8025**.

## 2. Test accounts (from `db:seed:e2e`)

The screen and **every** action on it (create / edit / version / activate / deactivate / **archive**)
are gated by the single **`import_trips`** key — held by **exactly Admin + Operations Manager**. No new
key is introduced; archive is **not** gated by the Admin-only `delete_archive`. Passwords are per-account
(see `packages/db/seed/e2e-accounts.ts`).

| Email | Password | Role | `import_trips` → manage templates | Can create a customer? (`manage_commercial_data`) |
|---|---|---|:--:|:--:|
| admin@braziltransports.com.br | `ChangeMe!Admin123` | Admin | ✅ | ✅ |
| opsmanager@braziltransports.com.br | `ChangeMe!Ops123` | Operations Manager | ✅ | ✅ |
| finance@braziltransports.com.br | `ChangeMe!Finance123` | Finance | ❌ | ❌ |
| dispatcher@braziltransports.com.br | `ChangeMe!Dispatcher123` | Dispatcher | ❌ | ❌ |
| fleetcoord@braziltransports.com.br | `ChangeMe!Fleet123` | Fleet Coordinator | ❌ | ❌ |

> **Use `dispatcher@` (or `finance@`) for the negative authz checks** (§5.0): they lack `import_trips`,
> so the nav item is hidden, direct navigation to `/admin/import-templates` **redirects to `/`**, and the
> API returns **403**. (`permissions.ts` is authoritative: `import_trips` = Admin + Operations Manager
> only; Dispatcher does **not** hold it.) **Control Tower** and **Executive
> Viewer** also lack the key but aren't seeded as accounts — change a user's role in `/admin/users` to
> exercise them, or rely on `packages/shared/src/auth/permissions.test.ts`.

## 3. Seeded / reference data

- **Customer** (`db:seed:master-data`): **"Shopee (Demo)"** / code **`DEMO-SHOPEE`** + two locations.
  The screen always operates within one selected customer.
- **Optional seed template** (`db:seed:import`): one CSV template, **"Padrão Shopee (scaffolding)"**,
  v1, active. **Labeled scaffolding** (documented defaults), not signed-off customer content.
- **Recognized target fields** drive the grouped picker (single source of truth: `MAPPED_*_FIELDS` in
  `@brazil-tms/shared`, so adding a field later needs **no UI change**). The four pt-BR groups:

  | Group (pt-BR header) | Shared set | Target fields |
  |---|---|---|
  | **Texto** | `MAPPED_STRING_FIELDS` | `externalTripId`, `originCode`, `destinationCode`, `statusLabel`, `plannedVehicleType`, `plannedRouteNotes` |
  | **Data e Hora** | `MAPPED_DATE_FIELDS` | `plannedPickupWindowStart`, `plannedPickupWindowEnd`, `plannedDeliveryWindowStart`, `plannedDeliveryWindowEnd` |
  | **Número** | `MAPPED_NUMBER_FIELDS` | `plannedVolumeUnits`, `plannedWeightKg`, `plannedPalletCount`, `plannedDistanceKm`, `plannedTransitTimeMinutes` |
  | **Estruturado** | `MAPPED_JSON_FIELDS` | `plannedServiceRequirements` |

> Real per-customer template **content** (the actual Shopee / DHL eCommerce / Mercado Livre column names
> + formats) stays **BLOCKED** on PRD §29 Input #1 (sample files). This guide exercises the screen with
> documented-default values — no real customer column names are invented.

## 4. Automated tests

```powershell
pnpm lint ; pnpm typecheck ; pnpm build           # static gate (route exports, types, build)

# Unit only (NO DB needed): the pure form helpers + the i18n key guard. Run from the repo root.
pnpm exec vitest run --project web `
  apps/web/lib/imports/import-templates-form.test.ts `
  apps/web/lib/messages.test.ts
# (also worth running) the permission matrix that proves import_trips = Admin + Ops Manager:
pnpm exec vitest run packages/shared/src/auth/permissions.test.ts
```

`import-templates-form.test.ts` covers the extracted pure helpers: `findDuplicateTargets` (incl. the
N>2 case), `nextVersion` (max-for-name + 1), `hasDateTargetWithoutFormat`, and `deriveRequiredOverrides`
(the per-row "Obrigatório" → `requiredOverrides` projection). `messages.test.ts` asserts the new
`ImportTemplates` keys resolve and contain **no dots** (next-intl's nesting separator — a dotted key
breaks every page render).

**End-to-end** (`apps/web/e2e/import-template-admin.spec.ts`, 15 tests). Run against a **prod build** with
`--workers=1`; a stale `next dev` sharing `.next` can corrupt a prod build, so don't run a dev server at
the same time:

```powershell
pnpm --filter @brazil-tms/db db:seed:e2e                 # reset accounts first (role-change specs elsewhere pollute them)
pnpm --filter @brazil-tms/web build
pnpm --filter @brazil-tms/web start                      # Terminal C — prod server on :3000

# in another terminal:
$env:PLAYWRIGHT_BASE_URL='http://localhost:3000'
pnpm --filter @brazil-tms/web exec playwright test import-template-admin --workers=1 --retries=2
```

> Why `--retries=2`: the local box is latency-prone (the app's DB pool + the worker's `pgboss` polling),
> and one e2e (the 6-navigation deactivate test, marked `test.slow()`) is heavy. CI runs with `retries:
> 2` for the same reason; locally the suite passes **15/15**. HTTP-status + authz assertions
> (401/403/redirect) live in this e2e spec, **not** in `route.test.ts` (web Vitest only includes
> `lib/**`).

The e2e spec covers: create→appears-in-selector, the grouped target picker, duplicate-target /
zero-mapping blocks, edit-persists, "Criar nova versão" (incl. **archived-aware** numbering),
duplicate-key pt-BR message, deactivate/reactivate→selector, archive→read-only, the last-active
warning, the **Obrigatório → requiredOverrides** projection (asserted via the API), and the Dispatcher
**403 + redirect** authz cases.

## 5. Manual walkthrough (maps to the spec's user stories)

Open **http://localhost:3000**, sign in. UI is **pt-BR**. Reach the screen two ways (FR-011):
Administration → **"Modelos de Importação"** (`/admin/import-templates`), or the **"Gerenciar modelos"**
button on the Trip Import screen (`/imports`).

### 5.0 Authz
- Logged out: `GET /api/import-templates?customerId=…` → **401**.
- As **dispatcher@** (lacks `import_trips`): the **"Modelos de Importação"** nav item is hidden; visiting
  `/admin/import-templates` directly **redirects to `/`**; `GET` and `POST /api/import-templates` → **403**.
- As **admin@** / **opsmanager@**: full access.

### 5.1 US1 — author a customer's import template in-app *(the MVP / SC-001)*
1. As **admin@** or **opsmanager@**, open **`/admin/import-templates`** and pick **Shopee (Demo)**
   (`DEMO-SHOPEE`) from the **Cliente** selector. If you skipped `db:seed:import`, the list shows
   **"Nenhum modelo para este cliente."** — the gap this slice closes.
2. Click **"Novo modelo"**. Fill **Nome**, **Versão** (defaults to 1), **Tipo de arquivo** (CSV / XLSX).
   Add at least one mapping under **Mapeamento de colunas**: type the **Coluna do arquivo** (the literal
   header in the customer's file, e.g. `id_viagem`) and pick the **Campo interno** from the **grouped
   single-select** — note the four pt-BR group headers **Texto / Data e Hora / Número / Estruturado**
   (FR-003; there is **no free-text** target, so a typo'd/unknown field can't be saved).
3. **Regras de leitura** are pre-filled with the documented defaults: **Fuso horário** `America/Sao_Paulo`,
   **Separador decimal** `,`, **Separador de milhar** `.`, and **Formatos de data empty** (editable).
4. **Salvar** → **"Modelo criado com sucesso."** (`POST /api/import-templates` → 201; audit
   `import_template.create`). Open **`/imports`**, pick the same customer → the new template appears in the
   **"Modelo"** selector (it's active && not archived).
5. **Footgun checks:**
   - Map the **same target on two rows** → save is blocked with an inline pt-BR hint **"Este campo já
     está mapeado em outra linha."** on each conflicting row (FR-002, client-only rule).
   - **Remove all mappings** → save is blocked with **"Adicione ao menos um mapeamento de coluna."**
   - Map a **Data e Hora** target but leave **Formatos de data** empty → on **Salvar** you get a
     **non-blocking** amber warning (FR-015); click **Salvar again to proceed** anyway.
   - Tick **"Obrigatório"** on a mapping → after saving, that field's `target` is stored in the
     template's **`requiredOverrides`** (the set the import worker enforces). Verify with
     `GET /api/import-templates?customerId=<id>` and check the row's `requiredOverrides`.

### 5.2 US2 — review, edit, and version templates
1. On a template row, click **"Editar"** (non-archived only). Change a mapping's source/target or a
   parsing rule → **Salvar** → **"Modelo atualizado com sucesso."** (`PATCH /api/import-templates/:id`,
   config fields; audit `import_template.update`). Reopen to confirm it persisted.
2. Click **"Criar nova versão"** → the create form opens **pre-filled** from that template with **Versão =
   highest existing + 1** (editable), and POSTs the existing create endpoint → both versions are now
   listed. The suggested version **accounts for archived versions too**, so it won't collide with a
   hidden archived `vN`.
3. Try to save a **(cliente, nome, versão)** that already exists (e.g. create a second template with the
   same name + version) → the specific pt-BR message **"Já existe um modelo com esse nome e versão."**
   (the `DUPLICATE_TEMPLATE` 409 mapped to a friendly string — never a generic error).

### 5.3 US3 — control which templates are available for import
1. **Desativar** an active template → it leaves the **`/imports`** "Modelo" selector (which shows only
   `active && !archived`); **Ativar** → it returns. (`PATCH … { active }`.)
2. **Arquivar** a template (soft-delete) → it's hidden from the default list; toggle **"Incluir
   arquivados"** to see it. An archived row is **read-only** — it offers **no Editar/Ativar/Arquivar**
   action, only **"Visualizar"** (a read-only inspection). There is no un-archive (out of scope).
3. **Last-active warning (FR-017):** when you **Desativar** or **Arquivar** a customer's **last** active
   (non-archived) template, a pt-BR confirmation warns that imports for that customer will be blocked;
   **Cancelar** aborts, **Prosseguir** proceeds (warn-and-allow). To see it deterministically, use a
   customer with exactly one active template (e.g. create a new customer in `/admin/customers`, give it
   one template here, then deactivate it — DEMO-SHOPEE keeps the seeded template active if you ran
   `db:seed:import`).

### 5.4 Audit (SC-006)
Every create/edit/state-change is attributable to the acting user via the **existing** import-template
audit actions (`import_template.create` / `import_template.update`, written by the frozen service). View
them in **`/admin/audit`** (Admin): there is **no dedicated `import_template` entity-type preset** (the
presets are Viagens/Exceções/Documentos/Cobrança/Exportações/Usuários), so filter via the **Ação**
dropdown — **"Modelo de importação criado" / "Modelo de importação atualizado"** — or search by the
template's id in the entity-id field. The rows also appear in the unfiltered global audit log.

### 5.5 Cross-link (FR-011)
From **`/imports`**, the **"Gerenciar modelos"** button jumps to `/admin/import-templates`; from
Administration, **"Modelos de Importação"** is the nav entry. Both are visible only to holders of
`import_trips`.

### 5.6 Optional — the full author→upload→trips chain *(worker required, SC-005)*
This is the only section that needs **Terminal B** (the worker). It demonstrates that a template authored
in-app actually drives an import for a customer that began with **no** template:
1. Skip `db:seed:import` so DEMO-SHOPEE starts empty; author a CSV template in §5.1 whose mappings match
   a small CSV you'll upload (e.g. headers `id_viagem,origem,destino` → `externalTripId,originCode,
   destinationCode`; mark `externalTripId` **Obrigatório**).
2. On **`/imports`**, select the customer + your new template, upload the CSV → the worker
   parses/validates → review the preview → **Confirmar** → trips are created/updated. (Sample fixtures:
   `packages/db/seed/fixtures/import-clean.csv` / `import-errors.csv`.)

## 6. Tear down

```powershell
docker compose -f infra/supabase/docker-compose.yml down -v   # stop + wipe the DB + Storage volumes
# stop the app (Ctrl+C in Terminal A) and, if started, the worker (Terminal B) / prod server (Terminal C)
```

> `down -v` wipes the database; re-run the §1 migrate + seeds after a fresh bring-up. 012 adds nothing
> durable, so there's no 012-specific migration or bucket to provision. Real per-customer template
> **content** remains **BLOCKED** on PRD §29 Input #1 — this guide exercises the screen with
> documented-default values, not final customer configs.
