# Brazil Transports — Linehaul Execution TMS

Execution-focused TMS (a "control tower"): import pre-planned customer trips
(Shopee, DHL eCommerce, Mercado Livre), assign resources, track milestones, manage
exceptions, store proof, and prepare billing exports. **Not** a route optimizer.

## Repo status

Planning + Spec-Driven Development phase. **No application code yet** — the repo is
docs + GitHub Spec Kit scaffolding. Build work happens feature-by-feature via Spec Kit.

## Documentation map (read the relevant one before working)

- `docs/PRD.md` — product source of truth (the WHAT/WHY): scope, requirements (IDs),
  data model, status machine, gating inputs (§29), decision log (§30).
- `docs/STACK.md` — authoritative tech & infra decisions (the HOW).
- `docs/PRINCIPLES.md` — KISS / DRY / YAGNI rules (the ≥3 rule for abstraction).
- `docs/DELIVERY-WORKFLOW.md` — branching, PRs, deploys, quality gates.
- `docs/SPEC-SLICING.md` — how the PRD is sliced into 9 Spec Kit features (+ ownership matrix).
- `.specify/memory/constitution.md` — governing rules; prevails on technical/process conflict.

On conflict: constitution + STACK govern HOW; PRD governs product scope.

## Non-negotiable constraints (these cause real mistakes if missed)

Self-hosted Supabase = **Postgres + Auth + Storage only**. Hard exclusions — do NOT
introduce these or propose them in any plan (amending requires a constitution change):

- **NO Supabase Realtime** — freshness is polling via TanStack Query, always.
- **NO Supabase Edge Functions.**
- **NO Redis / BullMQ / external broker** — background work uses a Postgres-backed
  queue (`pg-boss`/`graphile-worker`) + one Node worker process.
- **NO microservices** — one app + one worker. **NO route-optimization engine.**
- **RLS deferred** — authorization is enforced in the BFF only; never expose the
  Supabase gateway/PostgREST publicly; service-role key stays server-only.
- Customer variation (import templates, SLA, docs, reason codes) is **config-driven** —
  one import engine, never per-customer code.

Full rationale: `docs/STACK.md` and the constitution.

## Git & delivery (full rules: `docs/DELIVERY-WORKFLOW.md`)

- Work on short-lived feature branches off `dev`. Feature PRs target **`dev`**, never `main`
  (`gh pr create --base dev`). `main` is production.
- **AI must NOT merge to `main`**, approve/force prod deploys, or bypass CI/branch protection.
  Production promotion (`dev → main`) is human-only.
- End commit messages with the `Co-Authored-By` trailer the harness requires.

## Spec-Driven workflow

Flow: `/speckit-specify` → `/speckit-clarify` → `/speckit-plan` → `/speckit-tasks`
→ `/speckit-analyze` → `/speckit-implement`. Skills are **hyphenated** (not `speckit.*`).
Each spec must reference PRD sections/IDs rather than duplicating them, and stay within
one feature slice (see `docs/SPEC-SLICING.md`). The plan's Constitution Check gate must pass.

## Tech stack (once code exists; detail in `docs/STACK.md`)

Next.js App Router + TypeScript (strict) · Tailwind + shadcn/ui · TanStack Query + Table ·
Zod · Luxon. Monorepo: `apps/web`, `packages/{shared,db}`, `workers/`, `infra/`.
Start with two packages (`shared`, `db`); add more only with justification.

## Environment & conventions

- Windows + PowerShell host. Python/`rich` CLIs need UTF-8 (`PYTHONUTF8=1`) — set
  persistently; a running session may need `$env:PYTHONUTF8='1'` inline.
- Production UI is **pt-BR**; timezone `America/Sao_Paulo`; store timestamps in UTC; currency BRL.
- Code style is enforced by ESLint/Prettier — not by this file. Tests: Vitest + Playwright.

<!-- SPECKIT START -->
Active feature plan: `specs/013-predefined-import-template/plan.md` (Predefined Import Template).
For technologies, project structure, BFF/auth patterns, data model, contracts, and setup/test commands,
read that plan and its `research.md`, `data-model.md`, `contracts/`, and `quickstart.md`.
This is a **corrective simplification of slice 004 (trip import)** that **references** 004 (it does not edit the shipped
004 spec). **Problem**: on `/imports` the operator must pick an import template ("Modelo"), but there is **no UI to create
one**, the select is **optional in the form yet the parse worker hard-fails** the batch when none is attached ("Nenhum
modelo de importação selecionado."), and that reason is **invisible on `/imports/history`** — a silent trap. **Goal**:
remove template selection entirely. Ship **one in-code `STANDARD_IMPORT_TEMPLATE` constant** (`@brazil-tms/shared`
`src/import/standard-template.ts`) — the slice-004 demo mapping (`packages/db/seed/import-sample.ts`) **verbatim**, as one
`TemplateConfig` object: headers `id_viagem→externalTripId`(req), `origem→originCode`(req), `destino→destinationCode`(req),
`janela_coleta_*`/`janela_entrega_*` windows, `tipo_veiculo`, `status`; rules `dd/MM/yyyy HH:mm`, `America/Sao_Paulo`,
decimal `,`, thousand `.`; `requiredOverrides: []`. The **parse worker** (`workers/jobs/parse/index.ts`) uses the constant
whenever `batch.template_id` is null (replacing the null-template failure branch) and chooses CSV-vs-XLSX from
**`inferFileType(batch.fileName)`** — that helper is **relocated** into `@brazil-tms/shared` `src/import/file-type.ts` so
the BFF route and the worker share one canonical extension rule (DRY-for-correctness, the only extraction; precedent:
009 `onTimeExpr`). **The validate worker is UNCHANGED** — `loadRequiredOverrides(null)` already returns `[]` and status
labels are customer-keyed; **`createBatch` is UNCHANGED** — it already stores `template_id ?? null`. The `/imports` upload
screen (`apps/web/components/imports/trip-import-client.tsx`) collapses to **Cliente + Arquivo**: remove the Modelo
`Select`/`templateId` state/`templatesQuery`/the `/api/import-templates` call, stop sending `templateId`, add an
**always-visible pt-BR provisional banner** (new flat key `Imports.provisionalNotice`, mirroring the 009 banner), and
**prune** dead i18n (`template`/`selectTemplate`/`noTemplates`) + **rewrite** `uploadSubtitle`. The standard format is a
**labeled §29 (#2–#5) provisional default** — NOT marked complete; swapping a real signed-off format later is a
**single-object edit** (FR-010/SC-007). **Adds NOTHING durable**: NO new table, column (notably **no `file_type` column**),
enum, migration, permission key, package, worker job, or runtime dependency. The `import_templates` table + its
list/detail/create/update/archive endpoints stay **dormant** (retained for future per-customer configs; the deferred
slice-012 admin UI can recover them). Validation/dedup/confirm/status-mapping/history are **unchanged** (trips still land
in `received`); a wrong-columns file surfaces the **existing per-row reasons** (`MISSING_EXTERNAL_ID`/`UNKNOWN_LOCATION`)
with **no** header-level "wrong format" message, and an empty/header-only file shows an empty preview; surfacing
batch-failure reasons on the **history** screen is an explicit **follow-up (out of scope)**. New work: 2 shared symbols
(`STANDARD_IMPORT_TEMPLATE` + relocated `inferFileType`); 1 parse-worker edit; 1 client-screen edit; 1 i18n file edit
(`apps/web/messages/pt-BR.json`); ~3–4 test files (`parse.test.ts`, `messages.test.ts`, `e2e/trip-import.spec.ts`, an
optional shared unit test). Builds on `specs/004-trip-import-validation/` (the import pipeline, `applyTemplate` engine,
`import_batches`/`import_rows`, validation/preview/error-report/history it reuses). **Slice numbering note**: 010–012 are
already used by orphaned, reverted slices (in tag `mvp-001-012-snapshot`); this corrective slice is **013** to avoid
collision. Out of scope (Future): per-customer templates/formats, any template-management UI (the dormant slice-012),
history reason-visibility, and any new header-level/required-column validation.
<!-- SPECKIT END -->
