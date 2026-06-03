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
Active feature plan: `specs/010-trip-validation-dispatch-fix/plan.md` (Trip Validation Action & Dispatch Queue Hardening).
Follow-on micro-slice `specs/011-validation-error-reject/plan.md` adds the operator **reject** transition
`received → validation_error` ("Marcar erro de validação", with a reason carried on the existing `trip_events.notes`
field) — completing the validate/reject pair, **folded into the same PR #13**, UI-only, adds NOTHING durable, reuses
`update_trip_status` + the `POST /api/trips/:id/status` endpoint.
For technologies, project structure, BFF/auth patterns, data model, contracts, and setup/test commands,
read that plan and its `research.md`, `data-model.md`, `contracts/`, and `quickstart.md`.
This is a **corrective close-out slice** (slice 010, not one of the nine planned slices) that fixes **GitHub issue #11**:
an imported/created trip is always created in **`received`** (003's `createTrip` default; import never transitions — 004),
but **no shipped product surface advances it to `validated`**, so it can never be assigned through the UI — even though
`received → validated` is a **legal edge** (`packages/shared/src/domain/trip-status.ts:85`) and `POST /api/trips/:id/status`
(→ `transitionTripStatus`) already performs it under **`update_trip_status`**. Symptom: the Dispatch Board lists
non-assignable trips (`scope=active` → all 12 active statuses) and **Atribuir** on a `received` trip dies with a misleading
**`ILLEGAL_TRANSITION`** because the assignment route routes every non-`validated` `expectedFromStatus` into `reassignTrip`
(`assignment/route.ts:32-35` → `trip-assignments.ts:471-476`). Freshness is **polling** (no Realtime). It adds **NOTHING
durable**: **NO new table, enum, migration, permission key, package, worker job, or runtime dependency** (data-model delta
is *none* — only existing legal edges exercised). Four fixes: **(a) Validate action** — a new small `validate-action.tsx`
on **Trip Detail** (005) shown only for `received`/`validation_error`, calling the **existing** `/status` endpoint via the
**reused** generic `useRecordMilestone` hook (source `operator_manual`) — **no new endpoint/service/hook/permission**, and
per **Constitution III** never re-implements the status machine (`transitionTripStatus` already writes the append-only
`trip_events` + `audit_logs` + SLA recompute in one tx). **(b) Dispatch queue** — one constant in `dispatch-board.tsx:30`
goes `assigned=false&scope=active` → **`status=validated&assigned=false`**; the board read model needs **no change**
(`trip-board.ts` already accepts `status` as `oneOrMany(z.enum(TRIP_STATUSES))`; `trips-read.ts:341-343,356-361` honors it
and suppresses the active-scope default), and `assigned=false` already excludes `assigned`/`confirmed` (reassign is
initiated from Trip Detail / Control-Tower, never the board). **(c) Assignment error** — `assignment/route.ts` replaces the
client-driven ternary with an **explicit by-status branch** (`validated`→assign · `assigned`/`confirmed`→reassign · **else
→ `Conflict("NOT_ASSIGNABLE", "A viagem precisa ser validada antes da atribuição.")`**) covering **all** non-assignable
statuses; `Conflict` takes a **free-form string code** (`packages/db/src/errors.ts`) so **no error-type change**; the code
is added to `assignment-form.tsx` `ERROR_CODES` + a `Dispatch.errors.NOT_ASSIGNABLE` pt-BR label so it does not degrade to
`REQUEST_FAILED`; `reassignTrip`'s internal guard stays as defense. **(d) Seed** — `trip-domain-sample.ts` advances one
demo trip → `validated` and one → `assigned` **through the services** (never a raw `UPDATE`), keeping one in `received`, so
the hardened queue and validate→assign flow are demonstrable/e2e-testable. Authorization adds **NO new key**: validate
reuses **`update_trip_status`** (Admin/Ops-Manager/Dispatcher/Control-Tower — a superset of the §12.1 "System validation /
Operations" owner), assignment stays on **`assign_resources`**, board read stays on **`view_all_trips`**. Per
**Constitution II** nothing is invented: at MVP `received → validated` is a **deliberate operator promotion** (import/004
already ran the §11.2 checks and does not transition trips). **Out of scope (Future):** auto-validate-on-import (erases the
§12.1 Warning-review beat; YAGNI), per-customer/rule-driven validation criteria, a `validate_trip` key, bulk validate, and
a board-level validate action. New work: 1 new UI component + 3 UI edits + 1 route branch + 1 i18n edit + 1 seed edit + 3
e2e specs (1 new) + the `messages.test.ts` guard; **0** shared-package changes, **0** durable additions. Builds on
`specs/003-trip-domain-lifecycle/` (the `trip_status` machine, the `received → validated` legal edge, `transitionTripStatus`,
append-only `trip_events`/`audit_logs`, the demo seed), `specs/005-control-tower/` (the Trip Detail screen the Validate
action is surfaced on), and `specs/006-dispatch-assignment/` (the Dispatch Board queue + the assignment route/error this
slice hardens, and the `assign_resources` key). PR base **`dev`**; AI must **not** merge to `main`.
<!-- SPECKIT END -->
