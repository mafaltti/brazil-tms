<!--
SYNC IMPACT REPORT
Version change: (uninitialized template) → 1.0.0
Ratification: initial adoption 2026-05-29
Principles defined:
  I.   Simplicity First (KISS · DRY · YAGNI)
  II.  Execution-Focused Scope
  III. System-of-Record Integrity
  IV.  Authorization & Secrets Discipline
  V.   Configuration over Code for Customer Variation
  VI.  Spec-Driven Delivery
Sections added: Technology Constraints; Development Workflow & Quality Gates; Governance
Sections removed: none
Source docs: docs/PRINCIPLES.md, docs/STACK.md, docs/DELIVERY-WORKFLOW.md
            (PRD.md remains the product source of truth)
Templates:
  ✅ .specify/templates/plan-template.md  (Constitution Check gate populated)
  ✅ .specify/templates/spec-template.md  (reviewed — aligned, no change needed)
  ✅ .specify/templates/tasks-template.md (reviewed — aligned, no change needed)
  ✅ CLAUDE.md                            (reviewed — generic pointer, no change needed)
Deferred TODOs: none
-->

# Brazil Transports Linehaul TMS Constitution

## Core Principles

### I. Simplicity First (KISS · DRY · YAGNI)

Non-negotiable.

- Solutions MUST be the simplest that satisfy the current, in-scope requirement; speculative
  complexity is prohibited.
- Abstractions MUST NOT be introduced until a pattern repeats at least three (3) times with
  identical logic. One or two occurrences, slightly different logic, or "might need it later"
  are insufficient justification.
- Each change MUST be the minimal diff that achieves its goal; prefer small, reviewable PRs.
- Every PR description MUST state which principle(s) it applies and make trade-offs explicit
  (duplication vs. abstraction). New abstractions MUST cite concrete duplication or near-term,
  roadmap-backed use.

**Rationale**: a small team at modest scale; unmanaged complexity — not raw capability — is the
primary delivery risk.

### II. Execution-Focused Scope

- The system is a linehaul execution control tower and system of record — NOT a route optimizer,
  ERP, payroll, fleet-maintenance, or marketplace product.
- Work MUST stay within the current MVP scope and honor the declared non-goals; out-of-scope
  ideas MUST be deferred to the post-MVP backlog, never absorbed silently.
- Features gated on external business inputs (PRD Section 29) MUST NOT be marked complete until
  those inputs are supplied. Scaffolding against documented defaults is allowed but MUST be
  labeled as such.

**Rationale**: PRD §5 non-goals and §29 gating; prevents scope creep the team cannot absorb.

### III. System-of-Record Integrity

- Postgres is the durable system of record. The UI and clients MUST NOT own billing-readiness,
  final SLA classification, assignment-conflict authority, or permission decisions.
- The original customer plan MUST be stored separately from executed values and MUST remain
  immutable after import; later changes are recorded as audited updates.
- Status MUST be an explicit, enumerated state machine with declared legal transitions — never
  free-form strings.
- Critical operational history (events, audit, import/export batches) MUST be immutable;
  destructive operations MUST use soft-delete/archival, never hard delete of auditable records.

**Rationale**: billing disputes and customer audits require trustworthy, reconstructable history.

### IV. Authorization & Secrets Discipline

- The BFF is the single source of authorization for MVP; all data access MUST be server-side
  through it. Row Level Security is deferred, and the Supabase API gateway / PostgREST MUST NOT
  be publicly exposed.
- The Supabase service role key is server-only (Next.js server runtime, worker, secure ops
  scripts). It MUST NEVER reach browser/mobile bundles, client env vars, logs, uploads, or
  customer-facing exports.
- Sensitive actions MUST be audited: imports, plan/execution edits, assignments, status
  transitions, document verification, rate/billing changes, and permission changes.

**Rationale**: STACK §5; least privilege enforced at a single, testable layer.

### V. Configuration over Code for Customer Variation

- Customer-specific behavior — import templates/column mappings, SLA rules, document checklists,
  status-label mappings, reason codes — MUST be data/configuration-driven, not hardcoded.
- Imports MUST use one shared mapping engine plus per-customer template configuration. A separate
  importer code package or a per-customer code branch MUST NOT be created.

**Rationale**: PRD risk "too many custom customer rules"; onboarding a customer stays a config
task, not a code change.

### VI. Spec-Driven Delivery

- Substantive work MUST flow specify → (clarify) → plan → tasks → (analyze) → implement using
  Spec Kit.
- PRD.md is the product source of truth (the WHAT/WHY). This constitution and STACK.md govern the
  HOW; for technical and process decisions they prevail on conflict.
- Features MUST be sliced small, by PRD phase / functional-requirement group; specs MUST reference
  PRD sections rather than duplicating them (DRY).

**Rationale**: keeps reviewed specs as the durable source instead of ad-hoc implementation.

## Technology Constraints

Authoritative detail lives in `docs/STACK.md`; on conflict, STACK.md governs the specifics while
the exclusions below remain binding.

Binding stack:

- Frontend/BFF: Next.js App Router + TypeScript (strict); Tailwind CSS + shadcn/ui + lucide-react;
  TanStack Table; TanStack Query; Zod; Luxon with canonical timezone `America/Sao_Paulo`
  (timestamps stored in UTC).
- Backend: self-hosted Supabase (Postgres, Auth, Storage); Next.js Route Handlers as the BFF; a
  Postgres-backed job queue (`pg-boss` or `graphile-worker`) driving a single Node.js worker
  process.
- Delivery: Caddy reverse proxy; Docker Compose (Supabase, app, worker); ESLint + Prettier;
  Vitest (unit) + Playwright (critical flows).
- Repository: a monorepo starting with exactly two packages — `shared` and `db`. New
  packages/services require justification under Principle I.
- Localization: production UI in Portuguese (pt-BR) from day one; currency BRL; timezone
  `America/Sao_Paulo`.

Hard exclusions (changing any requires a constitution amendment + architecture review):

- MUST NOT use Supabase Realtime. Polling via TanStack Query is the only freshness mechanism.
- MUST NOT use Supabase Edge Functions.
- MUST NOT introduce Redis, BullMQ, or any external queue/broker; background work uses the
  Postgres-backed queue + worker.
- MUST NOT split the system into microservices; the deployable shape is one app + one worker.
- MUST NOT build a route-optimization engine in MVP.

## Development Workflow & Quality Gates

Branching and merges (`docs/DELIVERY-WORKFLOW.md` is the single source of truth):

- `main` = Production, `dev` = Development/Integration. All work happens on short-lived feature
  branches; no direct pushes to `dev` or `main`.
- Feature PRs MUST target `dev`. Production promotion is a `dev → main` PR. Production merges are
  human-only.
- AI agents MAY branch from `dev`, commit small reviewable changes, and open PRs to `dev`. AI
  agents MUST NOT merge into `main`, approve/force production deploys, or bypass CI/branch
  protection.

Quality gates (enforced in CI before merge):

- Lint + typecheck pass; build passes; tests pass when applicable; the PR uses the PR template
  (including how to test, or why it is not needed).
- Test focus (STACK §3.13): import validation, duplicate detection, status transitions,
  assignment-conflict checks, billing-readiness rules, and permission checks (Vitest); critical
  UI and workflows covered by Playwright.

Spec Kit flow: constitution → specify → (clarify) → plan → tasks → (analyze) → implement. The
plan's Constitution Check gate MUST pass before implementation begins.

## Governance

- This constitution supersedes ad-hoc practice. For technical and process decisions it governs
  alongside `docs/STACK.md` and `docs/DELIVERY-WORKFLOW.md`; `docs/PRD.md` governs product scope.
  On unresolved conflict the constitution prevails, and the conflicting document MUST be reconciled.
- Amendments MUST be made via a PR that: edits this file, states the change and rationale, bumps
  the version per the policy below, and updates dependent Spec Kit templates (plan/spec/tasks) in
  the same change.
- Versioning policy (semantic): MAJOR = removal or redefinition of a principle, or an incompatible
  governance change; MINOR = a new principle/section or materially expanded guidance; PATCH =
  clarifications and wording.
- Compliance: every PR MUST verify compliance and cite the principle(s) applied (Principle I
  decision criteria). Violations block merge unless recorded in the plan's Complexity Tracking
  with explicit justification and the rejected simpler alternative. Runtime guidance for agents
  lives in `CLAUDE.md` and `docs/`.

**Version**: 1.0.0 | **Ratified**: 2026-05-29 | **Last Amended**: 2026-05-29
