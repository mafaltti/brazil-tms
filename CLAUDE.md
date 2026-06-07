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
Active feature plan: `specs/014-auto-validate-imports/plan.md` (Auto-Validate Imported Trips).
For technologies, project structure, BFF/auth patterns, data model, contracts, and setup/test commands,
read that plan and its `research.md`, `data-model.md`, `contracts/`, and `quickstart.md`.
This is a **corrective behavior change** to the import→dispatch flow that **references** shipped slices 004 (import
pipeline), 006 (dispatch/assignment), 013 (predefined import template), and 003 (trip status machine) — it does **not**
edit their shipped specs. **Problem**: imported trips land in trip status `received`, but assignment requires `validated`
(`received → validated → assigned`), and there is **no operator UI** to make that hop (the assignment panel renders only
for validated/assigned/confirmed; the execution-timeline milestone buttons exclude validated). So every imported trip is
stranded before dispatch, and the Expedição (`/dispatch`) queue — which queries `assigned=false&scope=active`, and
`scope=active` includes `received` — lists those trips with an "Atribuir" action that fails with `ILLEGAL_TRANSITION`
("Operação não permitida para o status atual da viagem"). **Goal**: **auto-validate on import** — since the import
pipeline already validates every row (outcome valid/warning/error, only valid/warning applied), a row that passed import
validation **is** a validated trip; collapse the redundant trip-validation step. **Decision (spec §Clarifications,
born-validated, atomic)**: extend the promoted `createTrip` (`packages/db/src/trips/trips-service.ts`) with an **optional
3rd param `initialStatus: TripStatus = "received"`** (replacing the hardcoded `"received"` at the insert AND the
`trip.create` audit `newValue`); the **two** `createTrip` sites in `workers/jobs/confirm-import/index.ts` (lines ~149
`new`/`potential_duplicate`, ~171 `update`-vanished→create) pass `"validated"`. The trip is **born `validated`** in
`createTrip`'s single transaction — never first persisted as `received` — so **no** worker-crash window can strand it
(verified across crash/re-run orderings; a unique-key race re-resolves to a status-neutral `updateTripPlan`). **Critical
invariant**: `updateTripPlan` paths (the `update` match decision and the race-fallback) and **all 9 other `createTrip`
callers** (notably `manual-create.ts`, kept `received`) are **UNCHANGED** — an `update` to an already-`assigned`/
`in_transit` trip must keep its status (FR-002). The legal-transition machine is **not** weakened: born-validated is an
*initial* insert status, not a transition; transitions out of `validated` still route through the guarded
`transitionTripStatus`. **Secondary fix**: narrow the dispatch queue — `apps/web/components/trips/dispatch/dispatch-board.tsx`
`DISPATCH_QUERY` from `"assigned=false&scope=active&sort=pickupStart"` to **`"assigned=false&status=validated&sort=pickupStart"`**
(a non-empty `status` suppresses the `scope=active` default in `buildWhere` and composes with `assigned=false` → only
unassigned validated trips; `status` is read via `params.getAll`). **Adds NOTHING durable**: NO new table, column, enum
value, migration, permission, package, worker job, or runtime dependency — reuses the existing `validated` enum value and
the creation+audit path (one backward-compatible optional param). New work: 1 db-service edit (+2 confirm-import call-site
args + header comment), 1 client query-string edit; tests — EDIT `workers/jobs/confirm-import/confirm.test.ts` (the
`received`→`validated` assertion + add: update doesn't downgrade an assigned trip; a confirm-created trip assigns
immediately), ADD a `dispatch-board.spec.ts` assertion (queue lists only validated; a seeded `received` trip excluded),
EDIT `e2e/trip-import.spec.ts` (post-confirm trips show "Validada"). All dispatch e2e already seed `currentStatus:"validated"`
(unchanged); `manual-create.test.ts`/`trips-service.test.ts` (default `received`) + `import-batches-service.test.ts` (batch
status) UNCHANGED. Out of scope (Future): a manual "Validar" UI action; born-validating the manual trip-create path;
backfilling pre-existing `received` trips; reaching `validation_error` via import (error rows never applied); history
batch-failure visibility.
<!-- SPECKIT END -->
