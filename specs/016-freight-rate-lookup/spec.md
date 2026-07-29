# Feature Specification: Freight Rate Lookup (Agregados)

**Feature Branch**: `016-freight-rate-lookup`

**Created**: 2026-07-13

**Status**: Draft

**Input**: User description: "quero que crie uma aba neste site para pesquisa de rotas onde ele irá pesquisar pela rota que está em uma planilha que irei te mandar, os usuários pesquisarão pelas rotas e irá aparecer o valor, o tipo de veículo e as observações que estão na planilha, ele pode pesquisar por preço, UR Origem, CIdade Origem, UF destino e Cidade Destino."

> **PRD relationship**: this is NEW product scope — an internal freight rate table
> (fretes de agregados) lookup, distinct from customer lanes (LANE-001..005) and from
> trip import (INT-001..007). FR-010 requires the PRD amendment (new §13.14 with
> RATE-LOOKUP-001..006, new §15.13 screen, one new §18 permission row, §10.1 scope item and
> a §30 decision-log entry). It does not modify the trip status machine, lanes, or
> any shipped slice. Constitution is not amended.
>
> **Naming**: the navigation label is **"Tabela de Fretes"** — NOT "Rotas", which is
> already the pt-BR label of the Lanes screen (`apps/web/messages/pt-BR.json`,
> navigation + admin lanes page). Two tabs named "Rotas" would be ambiguous for
> operators.
>
> **Source data**: spreadsheet `FRETES AGREGADOS - BRAZIL TRANSPORTS.xlsx`, sheet
> `Controle de Fretes` — 9 columns (`UF Origem`, `Cidade Origem`, `UF Destino`,
> `Cidade Destino`, `Km`, `Tipo Veículo`, `Valor Ida`, `Valor Reversa`,
> `Observações`). Routes come in groups of consecutive rows (one row per vehicle
> type; today CARRETA / TRUCK / TOCO) with origin/destination/km cells blank on
> continuation rows. Prices appear as `R$ 1.300,00`, as plain numbers, or as
> `-`/blank meaning "no price". Route (origin→destination) pairs are unique in the
> current file (verified 2026-07-13). **The repository is public: the real
> spreadsheet and its values (commercial prices, partner names, route list) must
> NEVER be committed** — the file enters the system only via runtime upload; this
> spec, tests, fixtures and seeds use only synthetic data.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Search freight rates (Priority: P1)

An internal user opens the new "Tabela de Fretes" tab, filters by origin (UF and/or
city), destination (UF and/or city) and/or price range, and sees the matching rates:
route (origin → destination), distance (km), vehicle type, one-way price (Valor
Ida), return price (Valor Reversa) and notes (Observações) — exactly the data
maintained today in the spreadsheet, without opening Excel or asking a colleague.

**Why this priority**: this is the requested capability — pricing lookups happen many
times a day during negotiation with agregados; the spreadsheet is a single-person
bottleneck.

**Independent Test**: load a synthetic fixture (e.g., routes UF1/CIDADE ALFA →
UF2/CIDADE BETA across three vehicle types); filter UF Origem = UF1 and Cidade
Destino = CIDADE BETA and verify the fixture's rows appear with prices, km and notes
matching the fixture; verify an unfiltered search lists all fixture rates.
(Verification against the real spreadsheet is a manual quickstart step, never an
automated test — FR-009.)

**Acceptance Scenarios**:

1. **Given** the rate table is loaded, **When** the user opens the "Tabela de
   Fretes" tab, **Then** all rates are listed (route, km, vehicle type, Valor Ida,
   Valor Reversa, Observações) with pt-BR currency formatting and "—" where a value
   is not defined.
2. **Given** filter UF Origem selected, **When** applied, **Then** only rates with
   that origin UF remain, and the Cidade Origem combobox offers only that UF's
   cities.
3. **Given** a price range filter, **When** applied, **Then** only rates whose
   **Valor Ida** falls inside the range remain; rates without Valor Ida are excluded
   while the price filter is active; absence of Valor Reversa never excludes a row.
4. **Given** a synthetic city "SÃO EXEMPLO" in the data, **When** the user types
   "sao exemplo" in the city combobox, **Then** it matches (accent- and
   case-insensitive).
5. **Given** filters with no matching route, **When** applied, **Then** an empty
   state in pt-BR explains no rates match and offers to clear filters.
6. **Given** results are shown, **When** the user sorts by Valor Ida or Km, **Then**
   rows reorder accordingly; rows without the sorted value go last.

---

### User Story 2 - Load and replace the rate table (Priority: P1)

An authorized user (Admin or Finance) uploads the spreadsheet (fixed format above) in
the "Tabela de Fretes" tab. The system validates the file, normalizes the data (fills
down grouped origin/destination/km cells; Observações and Tipo Veículo are per-row
and never filled down; parses both `R$ 1.300,00` and plain numeric price formats;
treats `-`/blank as "no price") and **replaces** the whole table atomically. The
import records who uploaded, when, the file name and the resulting route/rate
counts. If the file is invalid, nothing changes and the errors are reported with row
numbers.

**Why this priority**: without a load path there is nothing to search; replace-all
keeps the spreadsheet as the single source of truth the team already maintains.

**Independent Test**: upload a synthetic spreadsheet fixture and verify its routes
and rates load; re-upload a modified fixture and verify the table reflects only the
new file; upload a broken fixture (missing header) and verify a clear pt-BR error
and unchanged data.

**Acceptance Scenarios**:

1. **Given** an Admin or Finance user on the tab, **When** they upload a valid
   spreadsheet, **Then** the table is fully replaced and a summary shows routes and
   rates loaded.
2. **Given** a file with an unexpected header or unreadable sheet, **When**
   uploaded, **Then** the import is rejected listing the problems (with row numbers
   where applicable) and the previous data remains intact and searchable.
3. **Given** a user in any other role, **When** they open the tab, **Then** the
   upload action is not available to them (search only).
4. **Given** a completed import, **When** the audit trail is consulted, **Then** it
   shows file name, user, timestamp and row/route counts.

---

### Edge Cases

- Price cells contain `-`, blank, plain numbers or formatted strings
  (`R$ 9.999,99`): all parse to either a decimal BRL value or "no price"; any other
  unparseable content is an import error naming the row and column.
- Continuation rows (blank origin/destination) belong to the route group started by
  the last non-blank row; a file whose first data row is a continuation row is
  rejected.
- Observações and Tipo Veículo apply ONLY to their own row (never filled down): a
  note on the CARRETA row does not appear on the TRUCK/TOCO rows of the same route.
- A route group with fewer or more than 3 vehicle-type rows is accepted as-is (the
  vehicle types come from the file; CARRETA/TRUCK/TOCO is the current convention,
  not a fixed enum).
- Duplicate route+vehicle-type combinations in the file: import is rejected listing
  the duplicated rows (the spreadsheet is the source of truth and must be fixed
  there; the current real file has no duplicates — verified).
- Km missing for a route: allowed; displayed as "—" and sorted last.
- Notes longer than the column width are truncated in the table with the full text
  available on hover/expand.
- The table is empty (before first import): the tab shows an empty state; Admin and
  Finance see the upload call-to-action, other roles see "tabela ainda não
  carregada".
- Concurrent search during import: search keeps serving the previous data until the
  replace commits (no partial table is ever visible).
- Spreadsheet with extra trailing empty columns/rows (present in the real file):
  ignored silently.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The app MUST offer a "Tabela de Fretes" navigation tab visible to the
  seven internal MVP roles (PRD §18: Admin, Ops Manager, Dispatcher, Control Tower,
  Fleet/Carrier Coordinator, Finance, Executive) and NOT to Customer Viewer (current
  or future), showing the freight rate table with columns: UF/Cidade Origem,
  UF/Cidade Destino, Km, Tipo Veículo, Valor Ida, Valor Reversa, Observações. UI
  copy in pt-BR; prices formatted as BRL.
- **FR-002**: Users MUST be able to filter by UF Origem, Cidade Origem, UF Destino,
  Cidade Destino and by price range (min/max) applied to Valor Ida. City filters are
  searchable comboboxes populated from the loaded dataset, restricted to the
  selected UF when one is chosen, matching accent- and case-insensitively. Filters
  combine (AND) and are clearable.
- **FR-003**: Rows without **Valor Ida** MUST be excluded from results only while
  the price filter is active; otherwise they appear with "—". Absence of Valor
  Reversa or Km never excludes a row.
- **FR-004**: Users MUST be able to sort results by Valor Ida and by Km (missing
  values last). Default order: UF Origem, Cidade Origem, UF Destino, Cidade Destino,
  then vehicle type in file order.
- **FR-005**: Admin and Finance users MUST be able to upload the spreadsheet (sheet
  `Controle de Fretes`, fixed 9-column header) to replace the entire rate table
  atomically: fill-down of grouped origin/destination/km cells only (Observações and
  Tipo Veículo are per-row), price parsing per Edge Cases, `-`/blank = no price. A
  rejected import leaves existing data untouched and reports errors with row numbers
  in pt-BR. Permission precedent: PRD §18 "Edit rates" (Admin, Finance).
- **FR-006**: Each import MUST be recorded (file name, user, timestamp, routes and
  rates loaded) and appear in the audit trail, consistent with the platform's audit
  pattern (PRD §13.13 AUTH-005 / §21.5; audit foundation from slice 001, audit views
  from slice 009).
- **FR-007**: Rate data MUST be served only to authenticated internal users through
  the BFF (no public or client-direct database access), consistent with the
  constitution (auth in BFF; no PostgREST exposure).
- **FR-008**: After a successful import, users with the tab already open MUST see
  the new data within 60 seconds without manually reloading the page (platform
  freshness standard: TanStack Query polling — NO realtime, constitution hard
  exclusion).
- **FR-009**: Tests, fixtures and seeds MUST use synthetic rate data only; the real
  spreadsheet, its values, route list and counts MUST NOT enter the repository
  (public repo). Verifying the real file load is a manual quickstart step.
- **FR-010**: `docs/PRD.md` MUST be amended in the same PR: new §13.14 "Freight Rate
  Lookup" with RATE-LOOKUP-001..006; new §15.13 "Freight Rates (Tabela de Fretes)" screen;
  one new §18 row ("Import freight rate table" — Admin, Finance; "View freight rate
  table" — all internal roles, not Customer Viewer); a §10.1 MVP-scope addition; and
  a §30 decision-log entry recording this feature as new scope added on user request
  (2026-07-13).

### PRD requirement IDs introduced by this slice (traceability)

| PRD ID (new §13.14) | Requirement essence | Covered by |
|---|---|---|
| RATE-LOOKUP-001 | System maintains an internal agregados freight rate table (route, km, vehicle type, one-way/return prices, notes) | FR-001, FR-005, Key Entities |
| RATE-LOOKUP-002 | Internal users can search/filter rates by origin UF/city, destination UF/city and price range, with sorting | FR-002, FR-003, FR-004, FR-008 |
| RATE-LOOKUP-003 | Results display km, vehicle type, both prices and notes in pt-BR/BRL | FR-001, FR-003 |
| RATE-LOOKUP-004 | Admin/Finance replace the table by uploading the standard spreadsheet; atomic replace; row-level errors | FR-005 |
| RATE-LOOKUP-005 | Every import is recorded and auditable | FR-006 |
| RATE-LOOKUP-006 | Rate data is restricted to internal roles and never exposed to customer-facing surfaces | FR-001, FR-007, FR-009 |

### Key Entities

- **Freight rate**: one row of the table — origin (UF, city), destination (UF,
  city), km (optional), vehicle type (free-form label, currently
  CARRETA/TRUCK/TOCO), valor ida (optional BRL), valor reversa (optional BRL),
  observações (optional text). Uniqueness: route (origin+destination) + vehicle
  type.
- **Rate import**: one upload event — file name, user, timestamp, outcome (routes
  and rates loaded, or rejection errors). Only the latest successful import's data
  is live (replace-all semantics).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user finds the price for a known route and vehicle type in under 10
  seconds from opening the tab, without opening the spreadsheet.
- **SC-002**: 100% of the routes and rates present in the uploaded spreadsheet are
  searchable and displayed with their exact values (spot-check: every price of a
  sampled route matches the file).
- **SC-003**: An authorized user replaces the whole table with a new spreadsheet
  version in under 1 minute, with zero manual data entry.
- **SC-004**: An invalid upload never corrupts or partially replaces the live table
  (search results are always from exactly one complete import).
- **SC-005**: Roles other than Admin/Finance have zero access to the upload action;
  Customer Viewer and unauthenticated requests get no rate data at all.

## Assumptions

- "UR Origem" in the request is read as **UF Origem** (matches the spreadsheet
  header).
- Price search applies to **Valor Ida** (the primary negotiated price); Valor
  Reversa is displayed but not filtered in this slice.
- The seven internal MVP roles can search; import follows the PRD §18 "Edit rates"
  precedent (Admin + Finance). Customer Viewer (post-MVP, §30) is explicitly
  excluded from all rate surfaces.
- Replace-all import semantics: the spreadsheet remains the single source of truth,
  maintained outside the system; no in-app row editing in this slice (future slice
  if needed).
- Vehicle types are stored as labels from the file (no new enum), keeping the import
  tolerant to future types (e.g., BITREM) without code changes — consistent with the
  config-driven variation principle.
- The freight rate table is internal company data, unrelated to customer lanes
  (LANE-004 standard rate is per-customer contracted lane pricing; this table is
  agregado spot pricing) — kept as a separate entity on purpose.
- Volume is small (hundreds of rows); server-side pagination is unnecessary — the
  BFF returns the filtered set and TanStack Table handles the rest.
