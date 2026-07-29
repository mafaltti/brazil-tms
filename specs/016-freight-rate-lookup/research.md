# Research — 016 Freight Rate Lookup

## R1 — Synchronous parse in the BFF (no pg-boss job)

**Decision**: parse + validate + replace inside the POST handler, single transaction.
**Rationale**: the sheet is ~100–500 rows / < 100 KB; the 004 pipeline (parse →
validate → detect-duplicates jobs, batch status machine, row-resolution UI) exists for
large per-customer trip files with a human error-resolution workflow. This import is
all-or-nothing (reject file with row errors), so the pipeline adds machinery with zero
workflow gain — PRINCIPLES ≥3 rule and KISS. Constitution's "background work in the
worker" governs *heavy/async* work (SLA sweeps, exports); precedent for trivial
in-request work: trips CSV export route.
**Alternatives**: reuse 004 pipeline (rejected: batch statuses, storage, polling UI
for a 1-second job); new dedicated job (rejected: still needs polling UI for the
result; sync gives immediate row-level errors in the 409 response).

## R2 — Uploaded file is not persisted

**Decision**: parse the multipart buffer and discard it; record only
`freight_rate_imports` metadata (file name, user, counts) + audit entry.
**Rationale**: replace-all semantics — the spreadsheet remains the single source of
truth outside the system (spec assumption); nothing re-reads the file later. Not
retaining a second copy of commercial pricing data also narrows exposure.
**Alternatives**: Storage bucket like `import_batches.storage_key` (rejected: no
error-resolution or reprocess workflow to serve).

## R3 — vehicle type = free-text label, not the fleet pgEnum

**Decision**: `vehicle_type text NOT NULL` storing the uppercased sheet label.
**Rationale**: the fleet enum (`van…rodotrem`, lowercase snake) models *fleet
resources*; the sheet vocabulary (CARRETA/TRUCK/TOCO today) belongs to whoever
maintains the sheet and must tolerate new labels (e.g. BITREM) without a migration —
spec assumption, config-driven principle. Mapping sheet labels onto the enum would
break on the first unknown label and silently couple two unrelated vocabularies.
**Alternatives**: reuse `vehicle_type` pgEnum (rejected above); new pgEnum (rejected:
same rigidity).

## R4 — Money and km representation

**Decision**: `valor_ida_cents` / `valor_reversa_cents` `bigint({mode:"number"})`
nullable; `km integer` nullable (parse rounds).
**Rationale**: house convention is integer centavos (`rates.base_amount_cents`,
`lanes.standard_rate_cents`). Sheet km values are whole numbers serialized as floats
(`843.0`).
**Price parser accepts**: `R$ 1.300,00` / `R$ 1.799,50` (pt-BR formatted), plain
numbers (`650`, `650.0` — treated as reais, not centavos), numeric cells; `-`, empty
→ null. Anything else → row/column error.

## R5 — Accent-insensitive city filtering

**Decision**: server filters by exact string equality; the city combobox filters its
options client-side with a shared `normalizeText` (NFD strip + lowercase), so typing
"sao" finds "SÃO …". Filter values always originate from the dataset (distinct
cities endpoint piggybacks on the single GET — the client derives options from the
unfiltered result it already polls).
**Rationale**: no `unaccent` extension dependency, no normalized shadow columns;
volume is tiny and the full set is already on the client.
**Alternatives**: Postgres `unaccent` + ILIKE (rejected: new extension for no gain);
`*_norm` columns (rejected: duplicated state).

## R6 — Pure normalizer in @brazil-tms/shared

**Decision**: `domain/freight-rates.ts` exports `normalizeFreightSheet(rows:
ReadonlyArray<ReadonlyArray<unknown>>)` returning `{ ok: true, rates, routeCount }`
or `{ ok: false, errors: [{ row, column, message }] }` (messages pt-BR); plus
`parsePriceCents`, `normalizeText`, `FREIGHT_SHEET_HEADER`.
**Rationale**: fill-down, per-row Observações/Tipo Veículo, duplicate rejection,
header validation and price parsing are the risky logic — pure functions make them
unit-testable without exceljs/DB (house pattern: shared holds pure domain
evaluators). `parse-xlsx.ts` (web, server-only) only converts the exceljs workbook
to `unknown[][]`.

## R7 — Naming: freight_rates vs existing rates domain

**Decision**: tables `freight_rates` / `freight_rate_imports`; route
`/api/freight-rates`; page `/freight-rates`; nav label "Tabela de Fretes".
**Rationale**: `rates` (slice 008) is per-customer contracted lane pricing; "Rotas"
(nav) is the Lanes screen. Names must not collide in nav, routes, tables or i18n
namespaces (spec validation finding).
