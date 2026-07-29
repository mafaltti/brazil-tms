# Tasks — 016 Freight Rate Lookup

Legend: `[P]` = parallelizable. Labels: (F) foundational, (US1) search, (US2) import,
(POL) polish/acceptance.

## Phase 0 — Foundational (F)

- [X] T001 (F) `packages/shared/src/auth/permissions.ts`: add `view_freight_rates`
      (all 7 roles) and `import_freight_rates` (finance; admin via superset) to
      PermissionKey, ALL_PERMISSIONS and ROLE_PERMISSIONS.
- [X] T002 (F) `packages/shared/src/domain/freight-rates.ts`: FREIGHT_SHEET_HEADER,
      normalizeText, parsePriceCents, normalizeFreightSheet (fill-down, per-row
      Observações/Tipo Veículo, dup rejection, header check, pt-BR errors) + types.
- [X] T003 (F) `packages/shared/src/schemas/freight-rate.ts`: freightRateFilterSchema
      (originUf/originCity/destinationUf/destinationCity/priceMinCents/priceMaxCents/
      sort) + FreightRateItem type; export from shared index.
- [X] T004 (F) [P] `packages/shared/src/domain/freight-rates.test.ts`: units —
      header mismatch, continuation-first-row reject, fill-down (km included,
      observações NOT), 3 price formats + `-`/blank/garbage, duplicate
      (route+vehicle) reject, uppercasing, trailing empty columns ignored. Synthetic
      data only.
- [X] T005 (F) `packages/db/schema/freight-rates.ts` (+ index.ts export):
      freight_rate_imports + freight_rates per data-model.md; then
      `pnpm --filter @brazil-tms/db db:generate` → migration 0009 (rename to
      0009_freight_rates.sql if needed).

## Phase 1 — US2 import path

- [X] T010 (US2) `apps/web/lib/freight-rates/parse-xlsx.ts`: exceljs buffer →
      `unknown[][]` from sheet "Controle de Fretes" (server-only; Conflict
      SHEET_NOT_FOUND if missing).
- [X] T011 (US2) `apps/web/lib/freight-rates/service.ts` — replaceFreightRates():
      tx { delete all; insert rates (importId); insert freight_rate_imports;
      writeAudit(tx, freight_rate_import/replace) } returning summary.
- [X] T012 (US2) `apps/web/app/api/freight-rates/import/route.ts`: POST multipart
      per contract (INVALID_FILE 409 with issues; 201 summary).
- [X] T013 (US2) `components/freight-rates/upload-dialog.tsx`: file input (.xlsx),
      mutation POST FormData, success toast with counts, 409 issues table pt-BR,
      invalidate ["freight-rates"].

## Phase 2 — US1 search path

- [X] T020 (US1) service.ts — queryFreightRates(filters): Drizzle where (exact
      matches; price bounds exclude null valor_ida when bound present), sort per
      contract (nulls last).
- [X] T021 (US1) `apps/web/app/api/freight-rates/route.ts`: GET per contract
      (freightRateFilterSchema.parse of searchParams).
- [X] T022 (US1) `apps/web/lib/freight-rates/client.ts`: useFreightRates(filters)
      (refetchInterval 30 s, keyed by filters) + useImportFreightRates mutation +
      formatCents helper reuse (check house util before writing one).
- [X] T023 (US1) `components/freight-rates/freight-rates-table.tsx` + filters:
      TanStack Table (template: master-data-table.tsx); UF selects + city
      comboboxes (options derived from unfiltered dataset, client accent-insensitive
      matching via normalizeText, city options restricted by chosen UF), price
      min/max inputs (reais → cents), sort headers Valor Ida/Km, "—" for nulls,
      observações truncated w/ title attr, empty states (no data vs no matches).
- [X] T024 (US1) `apps/web/app/(shell)/freight-rates/page.tsx`: server guard
      verifySession + can(view_freight_rates); passes canImport flag
      (can(role,"import_freight_rates")) to client.
- [X] T025 (US1) [P] `apps/web/lib/nav.ts` + `messages/pt-BR.json`: nav item
      freightRates ("Tabela de Fretes", icon Banknote, permission
      view_freight_rates) + FreightRates namespace (title, description, filters,
      columns, upload, errors, empty states).

## Phase 3 — Polish & acceptance (POL)

- [X] T030 (POL) [P] `apps/web/lib/freight-rates/service.test.ts`
      (skipIf !DATABASE_URL): replace-all atomicity (bad insert rolls back), query
      filters/sort/null-exclusion, audit row written.
- [X] T031 (POL) [P] `apps/web/e2e/freight-rates.spec.ts`: admin uploads synthetic
      fixture (built in-test with exceljs), searches, filters by price; dispatcher
      sees no upload button.
- [X] T032 (POL) docs/PRD.md amendment (FR-010): §10.1 item, §13.14 RATE-001..006,
      §15.13 screen, §18 rows (view: 7 internal; import: Admin+Finance), §30
      decision entry (2026-07-13).
- [X] T033 (POL) CLAUDE.md SPECKIT block → active plan 016.
- [X] T034 (POL) Quality gates: `pnpm lint && pnpm typecheck && pnpm build &&
      pnpm test`; fix fallout.
- [ ] T035 (POL) Manual quickstart.md pass with the REAL sheet (out-of-repo);
      commit + PR to dev (`gh pr create --base dev`) after owner confirms.
