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
Active feature plan: `specs/012-import-template-admin/plan.md` (Import Template Administration).
For technologies, project structure, BFF/auth patterns, data model, contracts, and setup/test commands,
read that plan and its `research.md`, `data-model.md`, `contracts/`, and `quickstart.md`.
This is a **corrective close-out slice** (slice 012, not one of the nine planned slices) that completes **CUST-003**
("configure customer-specific import templates", MVP) — which slice **004** owned but shipped only as a BFF API + worker,
never a user-facing screen. Today an import template can be created only by a developer (seed/API); every customer without
a seed shows "Nenhum modelo ativo para este cliente" on Trip Import and cannot import. **This slice is UI-only** and adds
**NOTHING durable**: **NO new table, column, enum, migration, permission key, package, worker job, or runtime dependency**
(data-model delta = NONE). It adds an **Import Templates** Administration screen
(`app/(shell)/admin/import-templates/page.tsx`, guarded by `verifySession` + `can(role,'import_trips')` + redirect) where
Admin/Operations-Manager create, edit, version, activate/deactivate, and archive a customer's templates, reusing the
**existing frozen** surface unchanged: the `import_templates` table, the `templateConfigSchema` contract, the recognized
`MAPPED_*_FIELDS` target sets, the `import_trips` permission, and the endpoints `GET/POST /api/import-templates` +
`GET/PATCH /api/import-templates/:id` (create/update already write the `import_template.create/.update` audit rows). Key
design (code-grounded, see `research.md`): a client screen (`components/imports/import-templates-client.tsx`) + a
react-hook-form form (`import-template-form.tsx`) using `zodResolver(templateConfigSchema)` extended by `.superRefine` for
the two UI-only rules the backend does NOT enforce — **no duplicate `target`** across mappings and a non-blocking
**date-target-without-date-format** warning; a **grouped single-select** target picker built from the shared
`MAPPED_STRING/DATE/NUMBER/JSON_FIELDS` (single source of truth → pt-BR group headers Texto/Data e Hora/Número/Estruturado);
a dedicated `lib/imports/import-templates-client.ts` (NOT `lib/master-data/client.ts`, which hardcodes
`/api/master-data/${entity}`); "Criar nova versão" = in-memory copy with `version = max+1` POSTing the existing create
endpoint; **archived = not editable** and the **last-active-template** warn-and-allow confirm are **client-enforced** (the
frozen `updateTemplate` has NO `archivedAt` guard and the DTO carries NO optimistic-lock token → last-write-wins).
Authorization adds **NO new key**: the screen and all actions (incl. archive) reuse **`import_trips`** (= **exactly Admin +
Operations Manager**, verified in `permissions.ts`/test; Dispatcher does NOT hold it, so the e2e 403/redirect case uses
Dispatcher) — archive stays on `import_trips` to match the frozen PATCH gate, NOT the Admin-only `delete_archive`.
Duplicate `(customer,name,version)` maps the existing **`DUPLICATE_TEMPLATE`** 409 to a specific pt-BR message. **Out of
scope (Future):** auto-detect template from file headers, template import/export, dry-run/preview, bulk ops, a
`manage_templates` key, un-archive, concurrent-edit locking, a backend archived-edit guard, API/email ingestion, and ANY
engine/worker/schema/data-model change. New work: 1 new page + 2 new UI components + 1 new client lib + 3 edits (`nav.ts`,
`trip-import-client.tsx`, `messages/pt-BR.json`) + 1 new e2e spec + 2 unit edits (`import-templates-form.test.ts`,
`messages.test.ts`); **0** shared/db/worker changes, **0** durable additions. Gated by PRD §29 Input #1: real per-customer
template **content** sign-off stays **BLOCKED** (sample files); the screen itself ships with documented-default values.
Builds on `specs/004-trip-import-validation/` (the Import Template entity, config-driven engine, template endpoints, and the
Trip Import screen + selector this slice feeds) and `001`'s `import_trips` + Administration shell. PR base **`dev`**; AI must
**not** merge to `main`.
<!-- SPECKIT END -->
