# Implementation Plan: Freight Rate Lookup (Agregados)

**Branch**: `016-freight-rate-lookup` | **Date**: 2026-07-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/016-freight-rate-lookup/spec.md`

## Summary

Add a "Tabela de Fretes" tab where the seven internal roles search the agregados
freight table (origin/destination UF+city, price range on Valor Ida) and Admin/
Finance replace the whole table by uploading the standard spreadsheet. One new schema
file (2 tables, migration 0009), two permission keys, one BFF route pair, a pure
normalizer in `@brazil-tms/shared` (fill-down + BRL price parsing, fully
unit-testable), one shell page + client components following the master-data
patterns, and the PRD amendment (FR-010).

## Technical Context

**Language/Version**: TypeScript strict, Node >= 20, Next.js 15 App Router, React 19
**Primary Dependencies**: Drizzle + postgres-js, Zod, TanStack Query + Table, shadcn/ui, exceljs (already used by the import worker), next-intl (pt-BR)
**Storage**: Postgres (self-hosted Supabase, Postgres-only); no Storage bucket use (file is parsed in-request and discarded — R2)
**Testing**: Vitest (shared normalizer unit tests; web service tests `describe.skipIf(!DATABASE_URL)`), Playwright e2e (synthetic fixture only)
**Target Platform**: existing web app (BFF) — no worker changes
**Performance Goals**: table ≤ ~500 rows; single query, no pagination (spec assumption)
**Constraints**: constitution hard exclusions (no Realtime/Edge/Redis/PostgREST; BFF-only authz); public repo — no real freight data in git (spec FR-009)
**Scale/Scope**: 1 screen, 2 endpoints, 2 tables, 2 permission keys

## Constitution Check

| Rule | Status | How |
|---|---|---|
| No Supabase Realtime | PASS | freshness via TanStack Query polling, 30 s (`FR-008`) |
| No Edge Functions | PASS | BFF route handlers only |
| No Redis/BullMQ/broker; one app + one worker | PASS | no queue at all: the sheet is ~100–500 rows, parsed synchronously in-request (< 1 s). The 004 worker pipeline exists for large per-customer trip files with row-level resolution workflow; reusing it here would add batch status machinery for nothing (KISS/YAGNI, PRINCIPLES ≥3 rule). Precedent: heavy = worker (billing export), trivial = in-request (trips CSV export). |
| No microservices / no route optimizer | PASS | lookup table only |
| RLS deferred; BFF authoritative; service-role server-only | PASS | `requireAuth` + `requirePermission` on both endpoints; browser never touches Postgres |
| Config-driven variation, no per-customer code | PASS | single fixed internal template (not customer data); vehicle types are free-form labels from the file (no new enum) |
| pt-BR UI, UTC storage, BRL | PASS | money stored as integer centavos (`*_cents bigint`, house convention from `rates.ts`); UI via `messages/pt-BR.json` |

## Project Structure (files touched)

```
packages/shared/src/
├── auth/permissions.ts                    # +view_freight_rates, +import_freight_rates
├── domain/freight-rates.ts                # NEW — pure normalizer + price parser (unit-testable)
├── domain/freight-rates.test.ts           # NEW — unit tests (synthetic data only)
├── schemas/freight-rate.ts                # NEW — Zod filter schema + types
└── index.ts                               # exports

packages/db/
├── schema/freight-rates.ts                # NEW — freight_rate_imports + freight_rates
├── schema/index.ts                        # export
└── migrations/0009_freight_rates.sql      # generated (drizzle-kit generate)

apps/web/
├── app/api/freight-rates/route.ts         # NEW — GET (view_freight_rates)
├── app/api/freight-rates/import/route.ts  # NEW — POST multipart (import_freight_rates)
├── lib/freight-rates/service.ts           # NEW — queryFreightRates / replaceFreightRates (+ audit)
├── lib/freight-rates/service.test.ts      # NEW — skipIf(!DATABASE_URL)
├── lib/freight-rates/parse-xlsx.ts        # NEW — exceljs buffer → raw rows (server-only)
├── lib/freight-rates/client.ts            # NEW — TanStack Query hooks (30 s polling)
├── app/(shell)/freight-rates/page.tsx     # NEW — server guard (view_freight_rates)
├── components/freight-rates/*.tsx         # NEW — table + filters + upload dialog (TanStack Table,
│                                          #        master-data-table.tsx as template)
├── lib/nav.ts                             # +freightRates item
├── messages/pt-BR.json                    # +Nav.freightRates, +FreightRates namespace
└── e2e/freight-rates.spec.ts              # NEW — synthetic fixture e2e

docs/PRD.md                                # FR-010 amendment (§10.1, §13.14, §15.13, §18, §30)
CLAUDE.md                                  # SPECKIT block → active plan 016
```

## Key Decisions (detail in research.md)

- **R1 — Sync parse in BFF, no worker/queue**: file is tiny; atomic replace inside one
  DB transaction; 409 with row-level errors on invalid file.
- **R2 — No Storage persistence of the uploaded file**: replace-all semantics keep the
  spreadsheet the single source of truth outside the system; only metadata + counts
  are recorded (`freight_rate_imports` + audit). Avoids retaining commercial data in
  two places for no workflow gain (YAGNI).
- **R3 — `vehicle_type` as free text label (uppercased)**, NOT the fleet `vehicle_type`
  pgEnum: the sheet vocabulary belongs to the sheet owner (CARRETA/TRUCK/TOCO today);
  an enum would make unknown labels an import failure requiring a migration.
- **R4 — Money as integer centavos** (`valor_ida_cents`, `valor_reversa_cents`),
  matching `lanes.standard_rate_cents`/`rates.base_amount_cents`. `km` integer
  (whole km in the sheet; rounded on parse).
- **R5 — City accent-insensitive matching is client-side** (combobox search over
  dataset values); the BFF filters by exact equality on values that came from the
  dataset itself. No unaccent extension needed.
- **R6 — Pure normalizer in `@brazil-tms/shared`** so fill-down/price/duplicate/header
  rules are unit-tested without exceljs or DB (house pattern: pure domain evaluators
  live in shared).

## Phases

- **Phase 0 (foundational)**: permissions, schema + migration, shared normalizer +
  schemas + tests.
- **Phase 1 (US2 — load path first, nothing to search without it)**: parse-xlsx,
  service.replaceFreightRates (tx: delete-all + insert + import row + `writeAudit`),
  POST route, upload dialog.
- **Phase 2 (US1 — search)**: service.queryFreightRates, GET route, client hooks,
  page + table + filters components, nav + i18n.
- **Phase 3 (polish/acceptance)**: PRD amendment (FR-010), CLAUDE.md SPECKIT block,
  service tests, e2e spec, quality gates (`pnpm lint && pnpm typecheck && pnpm build
  && pnpm test`), quickstart manual verification with the real sheet (out-of-repo).

## Complexity Tracking

No constitution violations to justify. New permission keys (2) follow the 001
catalog-extension pattern; no new packages; no worker changes.
