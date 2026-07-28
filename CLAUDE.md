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
Active feature plan: `specs/024-larger-resource-dialogs/plan.md` (Larger Resource Registration Dialogs — issue #31 [0008]).
**Presentation-only slice** (padrão da 020): os diálogos de criação de Motorista/Veículo/Reboque saem do `max-w-lg`
base (512px) para **`max-w-4xl` (896px) + `max-h-[90vh]`**, via `className` nos três `DialogContent` de
`drivers-client.tsx` / `vehicles-client.tsx` / `trailers-client.tsx` (o `cn()` usa tailwind-merge, então o `max-w-*`
passado sobrescreve o base limpo). TRAPS: (1) NÃO tocar `ui/dialog.tsx` — alargaria TODOS os diálogos do app;
(2) NÃO tocar os forms — `driver-form.tsx` é do PR #39 [022] e `vehicle-form.tsx` do PR #40 [023]; mexer aqui cria
conflito desnecessário entre PRs (por isso os pares de campos NÃO são re-agrupados — isso foi a 0007). Outros diálogos
de master-data (customers/carriers/locations/lanes) e páginas de edição ficam como estão (issue nomeia só os três).
e2e novo `dialog-size.spec.ts` mede boundingBox ≥ 850px no viewport 1280. Redesign com abas/3 colunas do sistema de
referência = futuro, se o negócio pedir.

Previous slice (015) context:
Collapse Validation Statuses into "Recebida".
For technologies, project structure, BFF/auth patterns, data model, contracts, and setup/test commands,
read that plan and its `research.md`, `data-model.md`, `contracts/`, and `quickstart.md`.
This is a **corrective, cross-cutting** change to the trip status machine that **references** shipped slices 003 (status
machine), 004 (import+validation), 006 (dispatch/assignment), 013 (predefined import template), 014 (auto-validate) — it
**supersedes 014's born-`validated`** decision and does **not** edit shipped specs; it **amends** `docs/PRD.md`
(§7, §9.1, §11.2/11.3/11.4, §12, §12.1, §19.1, §30). Constitution is **not** amended. **Scope (narrowed with the user
2026-06-07)**: collapse ONLY the three validation states — `received` ("Recebida"), `validation_error` ("Erro de
validação"), `validated` ("Validada") — into a single `received`. Remove `validation_error` + `validated` from the
**active** machine (18 → **16** values); `received` becomes the first dispatchable status. The `confirmed` step and
EVERYTHING `assigned`/`confirmed`-onward are **OUT OF SCOPE and UNCHANGED**. **Transitions**: `received → [assigned,
cancelled]`; `assigned → [confirmed, received, cancelled]` (`received` = unassign, was `validated`); delete the
`validation_error`/`validated` rows; `confirmed`-onward unchanged. `ACTIVE_TRIP_STATUSES` 12 → 10; `NON_EDITABLE` stays 6
(partition 10+6=16). **DB enum stays at 18 (2 dormant)** — Postgres has no `DROP VALUE`; keep `validation_error`/`validated`
in the `trip_status` pgEnum (frozen by 0002 + immutable `trip_events` history), mark them dormant, and **pin the Drizzle
columns** `trips.current_status` + `trips.disputed_from_status` to the 16-value `TripStatus` via `.$type<TripStatus>()`
(type-only, no SQL diff). **One durable add**: data-only migration **0008** (`--custom`) backfilling
`current_status`/`disputed_from_status` ∈ {validated, validation_error} → `received` (FR-006); `trip_events` left intact.
**Born-received**: REVERT 014 — drop `createTrip`'s `initialStatus` param; the two `confirm-import` create sites born
`received`; manual-create already `received`. **Dispatch/assign**: `DISPATCH_QUERY` `status=validated` → `status=received`;
`assignTrip` source guard + event/audit `validated` → `received`; `unassignTrip` target `assigned → received`; BFF assign
branch key `validated` → `received`; `ASSIGNABLE_STATUSES`/quick-assign gate `received`; `trip-status-badge` + pt-BR drop
the 2 keys; unassign dialog copy → "Recebida". **CRITICAL TRAPS**: (1) `import_batch_status` is a SEPARATE enum that ALSO
has `validated`/`confirming` — NEVER blind find-replace `'validated'`; batch `setBatchStatus("validated")` and all
`importBatches.status` refs STAY. (2) Several tests/e2e assert the OLD design and must **INVERT**, not just re-seed
(dispatch-board "received excluded" → included; trip-import "Validada" → "Recebida"; delete the born-validated unit test).
(3) `trip-plan.ts indexOf("confirmed")` stays valid (`confirmed` retained) — the full-collapse landmine does NOT arise here.
**Restart the pg-boss worker** after editing `confirm-import` (stale worker masks the fix; the `trip.create` audit born
status is the tell). Out of scope (Future): removing `confirmed`/the confirm step; any new status; SLA redesign; touching
`import_batch_status`; a manual "Validar" UI.
<!-- SPECKIT END -->
