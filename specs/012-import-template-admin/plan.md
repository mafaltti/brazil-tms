# Implementation Plan: Import Template Administration

**Branch**: `012-import-template-admin` | **Date**: 2026-06-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/012-import-template-admin/spec.md`

## Summary

Add an in-app **Import Templates** administration screen so an authorized operator (Admin / Operations
Manager) can create, edit, version, activate/deactivate, and archive a customer's import templates —
closing the `CUST-003` gap that Feature 004 shipped only as a BFF API + worker. The screen feeds the
existing Trip Import selector. **This is a UI-only slice**: it reuses the already-shipped
`import_templates` table, the `templateConfigSchema` contract, the `MAPPED_*_FIELDS` recognized-target
sets, the `import_trips` permission, and the existing endpoints (`GET/POST /api/import-templates`,
`GET/PATCH /api/import-templates/:id`) **unchanged**. New work = UI components + i18n + tests. **Data-model
delta = NONE; durable additions = NONE.**

Technical approach (grounded in existing house patterns — see `research.md`):

- A Server Component page under the Administration route group guards with `verifySession()` +
  `can(role, "import_trips")` + `redirect`, mirroring `app/(shell)/imports/page.tsx`.
- A client screen lists per-customer templates (TanStack Query, polling), with create/edit via a
  react-hook-form form using `zodResolver(templateConfigSchema)` extended by `.superRefine` for the two
  UI-only rules the backend does not enforce (no duplicate `target`; warn on a date target with no date
  format).
- The target-field picker is a **grouped single-select** built from the existing `SelectGroup`/
  `SelectLabel` primitives, options spread from the shared `MAPPED_*_FIELDS` (single source of truth — a
  future field appears automatically; Constitution V).
- "Criar nova versão" pre-fills the create form from a selected template (version = max+1, editable) and
  POSTs the existing create endpoint. Archive read-only and the last-active-template warning are enforced
  client-side (the frozen backend has no archived-edit guard). Duplicate `(customer, name, version)` maps
  the existing `DUPLICATE_TEMPLATE` 409 to a specific pt-BR message.

## Technical Context

**Language/Version**: TypeScript (strict) on Next.js App Router (React 19 / Next 15-era), Node ≥ 20.

**Primary Dependencies**: TanStack Query (polling + mutations), react-hook-form + `@hookform/resolvers/zod`,
Zod (the shared `templateConfigSchema`), shadcn/ui (`Select`/`SelectGroup`/`SelectLabel`, `Dialog`,
`Table`, `Button`, `Input`, `Label`), next-intl (pt-BR), Luxon. **All already in the repo — no new
dependency.**

**Storage**: Postgres `import_templates` table — **reused unchanged; no migration**. All persistence goes
through the existing BFF endpoints + `import-templates-service.ts`.

**Testing**: Playwright (critical flows + authorization/HTTP-status + rendered pt-BR messages) and Vitest
(extracted pure helpers under `apps/web/lib/**`, plus the `messages.test.ts` key guard). Per house
convention, route-level 401/403/404/409 assertions live in e2e, not in `route.test.ts`.

**Target Platform**: Web browser (operator UI) + Next.js server runtime (the BFF). Single app + worker;
this slice touches only the app.

**Project Type**: Web application in the existing monorepo (`apps/web`, with `@brazil-tms/shared`,
`@brazil-tms/db`). No new package.

**Performance Goals**: Standard interactive admin UI. List/forms render responsively; freshness is
TanStack Query polling with the ~30s `staleTime` convention; mutations invalidate queries (no Realtime).
No heavy processing in the request path (parsing/validation stays in the existing worker/engine).

**Constraints**: pt-BR UI; `America/Sao_Paulo` defaults for parsing rules; polling-only (NO Realtime, NO
Edge Functions); authorization in the BFF; **data-model delta = NONE**; one config-driven import engine
(no per-customer code). Real per-customer template **content** sign-off remains BLOCKED on PRD §29 Input #1
(sample files) — the screen ships and is demonstrable with documented-default values only.

**Scale/Scope**: 1 new screen; ~5 new files + 4 edits (see Project Structure); 16 recognized target fields
across 4 kinds; small per-customer template counts (handful per customer). One reviewable PR.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] **Simplicity (I)**: Reuses existing endpoints, the shared schema, the shadcn primitives, the
  master-data form/table patterns, and the `import_trips` key. **No new abstraction, package, or service.**
  The one judgment call — whether to extend the shared `MasterDataTable` (owned by 002) or use custom row
  actions — resolves to **custom action columns in the client component** (activate/deactivate + criar
  nova versão are 012-specific), avoiding changes to a shared component for a single consumer.
- [x] **Scope (II)**: Squarely completes the in-scope `CUST-003` / `INT-002`; all 10 deferred items stay in
  Out of Scope. Real per-customer template content is **labeled BLOCKED on §29 Input #1**, not marked
  complete (scaffolding/documented defaults only).
- [x] **System-of-record (III)**: Postgres remains the system of record; no UI-owned durable state. Status
  transitions (active/inactive, archive) and audit are performed by the **existing** service in its own
  tx; archive is **soft-delete** (`archived_at`), never hard delete. The immutable original-plan / audit
  history is untouched.
- [x] **Authz & secrets (IV)**: Access is via the BFF only; the screen and its endpoints are gated by the
  existing **`import_trips`** key (Admin + Operations Manager — verified in `permissions.ts`/test). No
  service-role key reaches the client. Sensitive actions (create/update/archive/activate) are audited by
  the existing `writeAudit`. **No new permission key**; archive is gated by `import_trips` to match the
  frozen PATCH endpoint (NOT `delete_archive`, which would diverge from the shipped gate).
- [x] **Config over code (V)**: The screen is a generic editor over the one config-driven engine; the
  target picker derives from the shared `MAPPED_*_FIELDS` so customer variation stays **data**, never
  per-customer code. No second importer, no per-customer branch.
- [x] **Tech constraints**: Next.js + TS strict, shadcn/ui, TanStack Query polling, Zod, Luxon. No
  Realtime, no Edge Functions, no Redis/broker, no new microservice, no route optimizer. No worker change.
- [x] **Workflow**: Feature branch `012-import-template-admin` off `dev`; PR targets `dev`; CI gates
  (lint/typecheck/build/Vitest/Playwright) must be green; PR template used. AI does not merge to `main`.

**Result: PASS** (initial and — see end — post-design). No violations; Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/012-import-template-admin/
├── plan.md              # This file
├── research.md          # Phase 0 — pattern decisions (Decision/Rationale/Alternatives)
├── data-model.md        # Phase 1 — reused entity shapes (delta = NONE) + recognized-target catalog
├── quickstart.md        # Phase 1 — how to seed, demo, and test
├── contracts/
│   └── import-template-admin-ui.md   # the existing BFF endpoints this UI consumes (no new endpoint)
└── tasks.md             # Phase 2 — /speckit-tasks (NOT created here)
```

### Source Code (repository root)

UI + i18n + tests only. **No file under `packages/db`, `packages/shared`, `workers/`, or any
`migrations/` is created or modified by this slice.**

```text
apps/web/
├── app/(shell)/admin/import-templates/
│   └── page.tsx                                   # NEW — Server Component guard (verifySession + can('import_trips') + redirect)
├── components/imports/
│   ├── import-templates-client.tsx                # NEW — list + create/edit + version + activate/deactivate + archive (Dialog confirm); polling
│   ├── import-template-form.tsx                   # NEW — RHF + zodResolver(templateConfigSchema)+superRefine; useFieldArray; grouped target Select
│   └── trip-import-client.tsx                     # EDIT — add "Gerenciar modelos" link to /admin/import-templates
├── lib/imports/
│   ├── import-templates-client.ts                 # NEW — typed fetch helpers + TanStack hooks for /api/import-templates(/:id); body.error.code mapping; pure helpers (dup-target, max-version)
│   └── import-templates-form.test.ts              # NEW — Vitest unit tests for the extracted pure helpers
├── lib/
│   └── nav.ts                                     # EDIT — add nav item { key:'importTemplates', href:'/admin/import-templates', permission:'import_trips' }
├── lib/messages.test.ts                           # EDIT — assert new ImportTemplates/Nav/Imports keys resolve and contain no dots
├── messages/pt-BR.json                            # EDIT — ImportTemplates namespace + Nav.importTemplates + Imports.manageTemplates (no new audit-action keys)
└── e2e/import-template-admin.spec.ts              # NEW — Playwright: create→selector, edit, nova versão, dup-409 message, activate/deactivate, archive read-only, last-active warn, authz
```

**Structure Decision**: Web application in the existing `apps/web`. The screen lives under the
Administration route group (`app/(shell)/admin/import-templates/`, following `admin/customers/page.tsx`)
because FR-011 places it in Administration; it is *also* linked from `/imports`. A single page handles
list + create + edit (no `[id]/page.tsx` route) — the customer-scoped single-page model is the minimal
shape and matches the master-data dialog pattern. A dedicated `lib/imports/import-templates-client.ts` is
used (NOT `lib/master-data/client.ts`, which hardcodes `/api/master-data/${entity}` and cannot address
`/api/import-templates`).

## Complexity Tracking

> No Constitution Check violations. This slice adds zero durable surface and introduces no new
> abstraction, package, or permission key. Table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |

## Post-Design Constitution Re-Check

After Phase 1 (data-model + contracts + quickstart), the design adds **no new entity, endpoint, permission
key, or dependency** — it only composes existing primitives and endpoints behind a new screen. All seven
gates remain **PASS**; Complexity Tracking remains empty.
