# Implementation Plan: Predefined Import Template

**Branch**: `013-predefined-import-template` | **Date**: 2026-06-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/013-predefined-import-template/spec.md`

## Summary

Remove import-template selection from the operator's trip-import flow. The parse worker stops requiring
a per-batch template and instead falls back to **one in-code `STANDARD_IMPORT_TEMPLATE` constant** (the
documented demo mapping, verbatim) whenever a batch has no template; CSV-vs-XLSX is chosen from the
uploaded file's **name extension** (not a template attribute). The `/imports` screen collapses to
**Cliente + Arquivo**, gains an always-visible pt-BR **provisional** banner, and its dead template
control + strings are pruned. Everything downstream of mapping (validate, dedup, confirm, error report,
history, status handling) is **unchanged** — notably, the validate worker already returns `[]` for a
null-template batch, so it needs no edit. **Adds nothing durable**: no table, column, enum, migration,
permission, package, worker job, or runtime dependency.

## Technical Context

**Language/Version**: TypeScript (strict), Node.js 22 · Next.js App Router (BFF) · single Node worker.

**Primary Dependencies**: existing only — `csv-parse`, `exceljs`, Luxon, Zod, TanStack Query, shadcn/ui,
`pg-boss`. **No new dependency.**

**Storage**: Postgres (self-hosted Supabase). **No schema change** — `import_batches.template_id` simply
stays `null` on the operator path; `import_templates` stays dormant.

**Testing**: Vitest (shared unit + web integration), Playwright (e2e `trip-import.spec.ts`,
`messages.test.ts`).

**Target Platform**: Linux server (Docker Compose: app + worker), pt-BR UI, `America/Sao_Paulo`.

**Project Type**: Web (Next.js BFF + worker) in a monorepo (`apps/web`, `packages/{shared,db}`, `workers/`).

**Performance Goals**: unchanged from slice 004 (parse/validate at MVP file volume; reports/list < 3 s
budgets not in scope here).

**Constraints**: polling-only (no Realtime); BFF-only authz; service-role key server-only; one config-
driven import engine (Constitution V); the standard format is a **labeled §29 provisional default**.

**Scale/Scope**: a small, bounded corrective slice — 1 new shared constant + 1 relocated helper, 1 parse-
worker edit, 1 client screen edit, 1 i18n file edit; ~3–4 test files touched. No NEEDS CLARIFICATION
remain (resolved in spec §Clarifications).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] **Simplicity (I)**: minimal diff — one constant + one parse-worker fallback + UI prune. The only
  extraction is relocating the existing `inferFileType` helper into `@brazil-tms/shared` so the BFF route
  **and** the worker share one canonical "extension → file type" rule (DRY-for-correctness, mirroring the
  009 `onTimeExpr` precedent). No new package; no speculative abstraction.
- [x] **Scope (II)**: within MVP scope; the standard format is **labeled provisional** (§29 #2–#5 not
  signed off) via a visible banner and is **not** marked complete — exactly the "scaffolding against
  documented defaults" the principle permits. History reason-visibility and per-customer formats are
  explicitly deferred.
- [x] **System-of-record (III)**: no durable change; the original-plan immutability, `trip_events`,
  `audit_logs`, and the status machine are untouched; trips still land in `received`. `import.create`
  audit content is unchanged (it never recorded `templateId`).
- [x] **Authz & secrets (IV)**: reuses `import_trips`; no endpoint, role, or exposure change; service-role
  key stays server-only; the dormant `/api/import-templates` routes keep their existing gate.
- [x] **Config over code (V)**: the **one shared mapping engine** (`applyTemplate`) is unchanged and still
  consumes a `TemplateConfig` *as data*; there is **no per-customer code branch** (one format for all).
  The in-code constant is a **labeled provisional default** standing in for the §29-blocked real
  per-customer config (the `import_templates` table + endpoints remain for when real configs arrive),
  precedent: slice 009 `DEFAULT_SLA_POLICY`. See Complexity Tracking for the explicit tension + why a
  hardcoded *default* (not hardcoded *variation*) is compliant.
- [x] **Tech constraints**: no Realtime/Edge/Redis/microservices/route-optimizer; polling unchanged;
  Postgres-backed queue + single worker unchanged.
- [x] **Workflow**: feature branch `013-…` off `dev`; PR targets `dev`; CI gates (lint/typecheck/build/
  tests) apply; AI does not merge to `main`.

**Result: PASS** (one tension recorded below — not a violation, but logged for transparency).

## Project Structure

### Documentation (this feature)

```text
specs/013-predefined-import-template/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions (consolidated from spec §Clarifications)
├── data-model.md        # Phase 1 — the STANDARD_IMPORT_TEMPLATE shape; no durable change
├── quickstart.md        # Phase 1 — how to verify (no-template import, banner, wrong-format)
├── contracts/
│   └── standard-import-template.md   # the constant + unchanged endpoints + i18n delta
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
packages/shared/src/import/
├── standard-template.ts     # NEW — STANDARD_IMPORT_TEMPLATE (TemplateConfig, demo mapping verbatim)
├── file-type.ts             # NEW — inferFileType(fileName) relocated here (shared by BFF + worker)
├── engine.ts                # UNCHANGED — applyTemplate consumes the TemplateConfig as-is
├── jobs.ts                  # UNCHANGED — ParsePayload stays {batchId, storageKey}
└── index.ts                 # export the two new symbols

workers/jobs/parse/
└── index.ts                 # EDIT — null-template → STANDARD_IMPORT_TEMPLATE; parser by inferFileType(batch.fileName)

workers/jobs/validate/
└── index.ts                 # UNCHANGED — loadRequiredOverrides(null) already returns []; status labels customer-keyed

apps/web/app/api/imports/
└── route.ts                 # EDIT — import inferFileType from @brazil-tms/shared (drop the local copy)

apps/web/lib/imports/
└── import-batches-service.ts # UNCHANGED — createBatch already stores templateId ?? null when none sent

apps/web/components/imports/
└── trip-import-client.tsx   # EDIT — remove Modelo Select/state/query + stop sending templateId; add provisional banner

apps/web/messages/
└── pt-BR.json               # EDIT — add Imports.provisionalNotice; rewrite uploadSubtitle; remove template/selectTemplate/noTemplates

# Tests
workers/jobs/parse/parse.test.ts          # EDIT — no-template batch uses the constant; XLSX picked by extension
apps/web/lib/messages.test.ts             # EDIT — provisionalNotice present; template keys gone; no dotted keys
apps/web/e2e/trip-import.spec.ts          # EDIT — flow has no template step; banner visible; wrong-format → per-row reasons
packages/shared/src/import/standard-template.test.ts  # NEW (optional) — constant validates against templateConfigSchema; inferFileType cases
```

**Structure Decision**: Web monorepo (existing). New work concentrates in `packages/shared/src/import`
(the constant + the relocated `inferFileType`), one parse-worker edit, one client component, and one i18n
file. No new directories, packages, or layers.

## Complexity Tracking

| Tension | Why acceptable | Simpler alternative rejected because |
|---------|----------------|--------------------------------------|
| **In-code `STANDARD_IMPORT_TEMPLATE` vs Constitution V** ("templates/column mappings MUST be configuration-driven, not hardcoded") | It hardcodes a **single shared default**, not **per-customer variation** — the engine stays config-driven (consumes a `TemplateConfig`), there is no per-customer code branch, and it is a **labeled §29 provisional default** (Principle II explicitly permits scaffolding against documented defaults). The `import_templates` table + endpoints remain dormant for when real signed-off configs arrive. Direct precedent: slice 009 `DEFAULT_SLA_POLICY`. | Seeding a customer-agnostic DB row would reintroduce durable data (contradicts the locked "dormant table / nothing durable") and still hardcodes the same mapping, just one indirection away; a per-customer template UI is exactly the deferred slice 012 the requester chose not to pursue now. |
| **Relocating `inferFileType` into `@brazil-tms/shared`** (a shared helper used by 2 consumers, below the ≥3 rule) | Not a new abstraction — an **existing** 5-line function moved so the BFF (upload validation) and the worker (parser choice) apply **one identical** "extension → file type" rule; divergence would be a correctness bug (a file accepted at upload but parsed wrong). DRY-for-correctness, same rationale as 009's `onTimeExpr`. | Duplicating the extension check in the worker risks the two copies drifting (e.g. a future `.xls`/`.tsv` addition applied in one place only), reintroducing the exact silent-mismatch class this slice removes. |
