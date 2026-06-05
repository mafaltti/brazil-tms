# Feature Specification: XLSX Typed Date-Cell Parsing

**Feature Branch**: `013-import-xlsx-date-parsing`

**Created**: 2026-06-05

**Status**: Draft

**Input**: User description: "I'm trying to import this xlsx and I'm getting error." A real customer file (Shopee linehaul tender — `trip_number`, `origin_station_code`, `eta_scheduled_origin_edited`, …) failed import: every data row came back `error` with `MAPPING_ERROR` / `UNPARSEABLE_DATE` even though the column mappings were correct.

**Source PRD sections**: §29 Input #1 (per-customer import templates / file content — DOCUMENTED-DEFAULT, real files BLOCKED). Builds on the **004** import engine (config-driven mapping + explicit Luxon date normalization).

**Primary requirement IDs**: CUST-003 (customer-specific import templates). Corrects the **004** import engine's date normalization (`normalize.ts` / `engine.ts`) and the worker's xlsx adapter (`workers/jobs/parse`).

**Slice ownership**: A **micro corrective slice** fixing a real-file defect in the **004** import engine. XLSX files store dates as **typed Excel datetime cells** (no text format); ExcelJS hands those back as JS `Date`s, and the worker's `cellToString` serialized them via `.toISOString()` → an ISO-8601 string. But `normalizeDate` only accepted the template's configured Luxon `dateFormats` (a Brazilian operator naturally configures `dd/MM/yyyy HH:mm:ss`, matching what they SEE in Excel). An ISO string never matches that format → `UNPARSEABLE_DATE` → **every row staged as `error`**. A naïve "just parse the ISO" fix is also wrong: ExcelJS labels the cell's wall-clock as UTC (`15:00` typed → `15:00Z`), but the operator means `15:00` America/Sao_Paulo (`18:00Z`) — honoring the `Z` would store times **3 h off**. This slice adds **NOTHING durable**: NO new table, column, enum, migration, permission key, package, dependency, or worker job (data-model delta = NONE). The fix is two code edits + tests: (1) the worker emits a **zone-less** ISO datetime for `Date` cells (drop the trailing `Z` so the wall-clock is preserved); (2) `normalizeDate` gains an **ISO-8601 datetime fallback** — a zone-less ISO is interpreted in the **template timezone** (correct wall-clock), an ISO carrying an explicit offset/`Z` is honored as an absolute instant. A bare ISO date with no time (no `T`) still throws, preserving the engine's "explicit, never an implicit `new Date()`" contract. The operator's natural `dd/MM/yyyy` format keeps working for CSV; xlsx typed dates now "just work" with that same template — no per-customer or per-file format string required. Builds on `specs/004-trip-import-validation/` (the engine, the worker parse job) and `specs/012-import-template-admin/` (the admin screen that edits these templates).

## Clarifications

### Session 2026-06-05

- Q: Fix in template config or in code? → A: **Code.** A config workaround (adding `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'` to `dateFormats`) unblocks immediately but is cryptic for operators and must be repeated per customer/file. The durable fix makes the engine handle typed cells natively.
- Q: How is the timezone resolved (ExcelJS labels the wall-clock as UTC)? → A: The worker emits the **wall-clock with no zone**; the engine interprets it in the **template timezone** (`America/Sao_Paulo` default). 15:00 in Excel → 18:00Z stored. Machine-independent (ExcelJS `excelToDate` is pure UTC math).
- Q: Does this loosen date parsing? → A: Only ISO-8601 **datetimes** (value contains a `T`) are accepted as a fallback. ISO is unambiguous; a bare date with no time still throws (regression-guarded).
- Q: New durable surface? → A: **None.** No schema, permission, dependency, or worker-topology change. The seeded default template (`dd/MM/yyyy HH:mm:ss`) is unchanged and now covers both CSV and xlsx.

## Requirements *(mandatory)*

- **FR-001**: The import engine MUST correctly map XLSX files whose date columns are typed Excel datetime cells, using the customer's existing template — without requiring an ISO format string in `dateFormats`. *(CUST-003)*
- **FR-002**: A typed date cell's wall-clock MUST be interpreted in the template's configured **timezone** (default `America/Sao_Paulo`) and stored as the correct UTC instant. *(PRD: store UTC, display SP)*
- **FR-003**: Date normalization MUST remain **explicit** — only configured Luxon formats and unambiguous ISO-8601 **datetimes** are accepted; ambiguous/unparseable values (incl. a bare ISO date with no time) MUST still throw `UNPARSEABLE_DATE`. *(004 R5; Constitution V)*
- **FR-004**: An ISO datetime carrying an explicit offset/`Z` MUST be honored as an absolute instant (not re-interpreted in the template zone). *(correctness)*
- **FR-005**: The CSV path and existing templates MUST be unaffected (the operator's `dd/MM/yyyy` format still wins for text cells). *(no regression)*
- **FR-006**: The slice MUST add **no** new table, column, enum, migration, permission key, package, dependency, or worker job. *(Constitution I)*

## Success Criteria *(mandatory)*

- **SC-001**: A real Shopee xlsx tender (typed date cells) imports through the standard pipeline with **0 `MAPPING_ERROR`** rows, using a template configured with the natural `dd/MM/yyyy HH:mm:ss` format. *(verified on `planilha1641.xlsx`: all rows map; 15:00 BRT → 18:00Z)*
- **SC-002**: Unit tests cover: zone-less ISO datetime → template-zone instant; ISO-with-`Z` → absolute instant; bare ISO date → throws; CSV `dd/MM/yyyy` unaffected; and the worker `cellToString`/`parseXlsxBytes` emit a zone-less ISO for `Date` cells. *(shared `engine.test.ts`, workers `parse-xlsx-dates.test.ts`)*

## Out of Scope *(deferred)*

- Auto-detecting the date format from cell styles, or a UI hint that a typed-date column needs no format. *(Future)*
- Reverting the dev-DB band-aid (the ISO format added to the running `Padrão Shopee (scaffolding)` template) — harmless once this ships; can be reset to `["dd/MM/yyyy HH:mm:ss"]` after the worker runs this branch.
- Worker process hygiene (the historical `…native WebSocket support…` failures) — already fixed in source (`13dbf72`, `StorageClient`); purely operational (run one fresh worker).
