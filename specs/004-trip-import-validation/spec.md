# Feature Specification: Trip Import, Templates, Validation, and Duplicate Handling

**Feature Branch**: `004-trip-import-validation`

**Created**: 2026-05-30

**Status**: Draft

**Input**: User description: "004 — Trip Import, Templates, Validation, and Duplicate Handling. Operations can upload customer trip plans, validate rows, detect duplicates, and create or update trips through import batches. One import engine, many customer template configs; matching keyed on customer + external trip ID; repeated external trip ID is an update or no-op, never a blocking duplicate; fuzzy duplicates flagged for review; unknown locations flagged for mapping; original file and row references preserved. Heavy parsing/validation runs in the worker queue. Real Shopee/DHL eCommerce/Mercado Livre sample files gate final customer-template sign-off."

**Source PRD sections**: §11.1, §11.2, §13.1, §13.2, §13.3, §14.1, §15.3, §19.1, §20.1, §22 (Phase 2), §23

**Primary requirement IDs**: CUST-003, LANE-005, INT-001, INT-002, INT-003, INT-004, INT-005, INT-006, INT-007

**Slice ownership**: `docs/SPEC-SLICING.md` slice 004 — owns the trip **import** surface (templates, file upload, validation, duplicate handling, import batches, manual trip creation). It **reuses, never redefines**: the platform/auth/audit/i18n primitives from slice 001, the master-data entities (Customer, Location, Lane, fleet) from slice 002, and the shared trip domain model, status machine, and audit semantics from slice 003. Trip viewing/board (005), dispatch (006), SLA (007), documents/billing (008), and reporting (009) are out of scope.

---

## Overview & Intent *(why this feature exists)*

Brazil Transports' top customers (Shopee, DHL eCommerce, Mercado Livre) deliver **pre-planned trips** as files, not as cargo-line bookings. This feature is the primary intake path for the control tower: Operations selects a customer, uploads that customer's file, the system maps the file's columns into the internal trip model using a **customer-specific template**, validates each row, detects duplicates, and — on confirmation — **creates or updates trips through the shared trip domain** (slice 003), recording everything as a durable **import batch**.

The single hard architectural rule is **one import engine, many customer configurations**: customer variation lives in template/mapping/status-mapping configuration, never in per-customer code. The single hard business rule is the **idempotent matching semantics**: a row is keyed on `(customer + external trip ID)`; a repeated external trip ID is an *update* or a *no-op*, **never a blocking duplicate**; a look-alike row with no matching ID is flagged as a *potential* duplicate for human review.

Because real customer file formats are a §29 business-input gate, the engine and its tests are built against sample fixtures and documented defaults, and **final per-customer template sign-off is blocked** until real Shopee/DHL/ML files are supplied (Constitution Principle II).

---

## Clarifications

### Session 2026-05-30

- Q: Which roles may upload files, configure templates, resolve errors, and confirm imports? → A: **Admin and Ops Manager only** (PRD §18 — "Import trips" is restricted to these two roles); all enforcement is in the BFF (RLS deferred).
- Q: How is a row's customer and its origin/destination locations resolved? → A: Customer is resolved by stable `customer code`; locations are resolved by **(customer, location code)** against **active** master data only (slice 002). An origin/destination that does not resolve is flagged as an **unknown location for mapping** (LANE-005), not silently dropped.
- Q: What status does a newly imported trip land in? → A: **Received** — the initial state of the shared status machine (slice 003). Import never sets billing status (it is a derived projection) and never writes the immutable original plan more than once.
- Q: On confirmation, are Warning rows applied? → A: **Yes.** Valid rows apply silently; **Warning** rows apply but are surfaced for attention; **Error** rows are excluded from creation/update until corrected.
- Q: How are large files processed without timing out the UI? → A: Parsing, validation, duplicate detection, error-report generation, and confirmation run as **background worker jobs** on the Postgres-backed queue; the screen reflects batch progress by **polling** (no Realtime).
- Q: Is the fuzzy-duplicate match tolerance fixed? → A: **No** — it is configuration with a documented default; final tolerance values need Ops confirmation against real files (sign-off blocked).
- Q: When a customer file carries a status/stage column, what does import do with it via Status Mapping? → A: **Record/validate only** — every imported trip is created in **Received**; Status Mapping normalizes the customer label for audit/reference but import **never drives status transitions** from the file (transitions are owned by dispatch (006) and execution (007)).
- Q: When a confirmed batch is applied and some accepted rows fail to persist, what is the outcome? → A: **Per-row best-effort and idempotent** — successful rows are applied, failures are recorded in the batch outcome counts and error report, and confirmation can be safely re-run to retry only the still-unapplied rows without double-creating trips.
- Q: How is a flagged unknown location resolved during import? → A: **Map to an existing active location only** — creating new locations remains a master-data function of slice 002; the system remembers the (file value → location) alias so future imports auto-resolve it.
- Q: If one file contains multiple rows with the same (customer + external trip ID), what happens? → A: **All colliding rows are flagged as Error** (in-file collision) and none are created until the file is corrected — no arbitrary first/last-wins.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Import new trips from a customer file (Priority: P1)

An Operations user opens the Trip Import screen, selects a customer, selects (or lets the system detect) that customer's import template, and uploads a CSV or spreadsheet of planned trips. The system maps the file's columns into the internal trip model, validates each row, and shows a preview with per-row status and an import summary (new / updated / duplicate / error). The user confirms, and the system creates the valid trips in **Received** status and records an import batch.

**Why this priority**: This is the core intake path and the reason the slice exists — without it, no customer trip can enter the control tower. It is the minimum viable product on its own.

**Independent Test**: Configure a template for one customer, upload a clean sample file, confirm, and verify new trips appear in Received status, each linked to an import batch that records the file name, user, timestamp, customer, and outcome counts.

**Acceptance Scenarios**:

1. **Given** an authorized user and a configured template, **When** they upload a valid CSV/XLSX file for a selected customer, **Then** the system parses the file, maps columns to internal trip fields, and presents a preview table with per-row validation status. *(INT-001, INT-002, INT-003, §11.1, §15.3)*
2. **Given** a parsed file with all rows valid, **When** the user confirms the import, **Then** the system creates one trip per row in **Received** status through the shared trip domain, each linked to the import batch. *(INT-003, §19.1, slice 003)*
3. **Given** any upload, **When** the file is received, **Then** an import batch record is created capturing file name, customer, uploaded-by user, timestamp, total rows, and outcome counts (new / updated / duplicate / error). *(INT-004)*
4. **Given** a large file, **When** it is uploaded, **Then** parsing and validation run as background work and the screen shows batch progress without blocking or timing out. *(STACK — worker queue; §11.1)*

---

### User Story 2 - Validate rows, surface errors, export and resolve them (Priority: P1)

After upload, the user sees which rows are Valid, which carry Warnings, and which are Errors, each with a clear, localized message. The user can export an error report of the failed rows (with original row references) to share or correct, fix the underlying problem (e.g., a mapping or a location), and re-validate or re-upload. Error rows are never created until resolved.

**Why this priority**: Real customer files always contain bad rows. Without validation, error messaging, and a resolution loop, the import path cannot be used in production. Independently testable and valuable on top of US1.

**Independent Test**: Upload a file containing rows with missing/invalid fields and verify each is classified (Valid / Warning / Error) with a clear message, that an error report can be exported, that Error rows are excluded on confirmation, and that correcting and re-importing clears them.

**Acceptance Scenarios**:

1. **Given** an uploaded file, **When** validation runs, **Then** each row is classified **Valid**, **Warning**, or **Error**, where Error blocks creation and Warning allows it with attention. *(§11.2)*
2. **Given** a row missing a required field, an inactive/unknown customer, an invalid pickup/delivery window, a missing vehicle type, or an unresolved location, **When** validation runs, **Then** the row is reported with a clear, localized reason identifying the original row. *(§11.2, LANE-005, §23)*
3. **Given** a validated batch with errors, **When** the user exports the error report, **Then** the report lists every failed row with its reason and original row reference. *(INT-006, §15.3)*
4. **Given** a batch with Error rows, **When** the user confirms the import, **Then** only Valid and Warning rows are applied and Error rows are excluded. *(§11.2)*
5. **Given** a corrected file or resolved mapping, **When** the user re-imports, **Then** the previously failed rows validate successfully. *(INT-006)*

---

### User Story 3 - Detect duplicates and apply update / no-op semantics (Priority: P2)

When a customer re-sends a plan, the system must not create duplicate trips. The user re-imports a file; rows whose `(customer + external trip ID)` already exists are treated as **updates** (when plan fields changed) or **no-ops** (when identical) — never as blocking duplicates. Rows with no matching external trip ID that nonetheless closely resemble an existing trip are flagged as **potential duplicates** for the user to review, and can only be created with a recorded reason.

**Why this priority**: Re-sends are routine; mishandling them either corrupts the board with duplicates or silently overwrites the original plan. Builds on US1/US2 and is independently testable.

**Independent Test**: Import a file, then re-import the same file unchanged (expect all no-ops, zero new trips), then re-import with changed plan fields on a known external trip ID (expect updates that preserve the original plan), then import a look-alike row with no external trip ID (expect a flagged potential duplicate requiring a reason).

**Acceptance Scenarios**:

1. **Given** a row whose `(customer + external trip ID)` has no existing match, **When** the import is confirmed, **Then** a new trip is created. *(§19.1)*
2. **Given** a row whose `(customer + external trip ID)` matches an existing trip with changed plan fields, **When** the import is confirmed, **Then** the trip's live planned fields are updated through the shared trip domain, the original imported plan is preserved, and the change is recorded as a customer update in the audit log. *(§19.1, slice 003)*
3. **Given** a re-import of identical data for an existing `(customer + external trip ID)`, **When** the import is confirmed, **Then** the row is reported as **unchanged** (no-op) and no new trip is created. *(§19.1, Decision §30)*
4. **Given** a row with no external-trip-ID match that matches an existing trip on customer + origin + destination + pickup window + vehicle type within the configured tolerance, **When** validation runs, **Then** the row is flagged as a **potential duplicate** for review and may be created only with a recorded reason. *(INT-005, §19.1)*
5. **Given** a matched trip already past **Confirmed**, **When** an import would change its plan fields, **Then** the update requires explicit authorized review before it is applied. *(§19.1, slice 003 review-gate)*

---

### User Story 4 - Flag unknown locations for mapping (Priority: P2)

When an imported row references an origin or destination that does not resolve to a known active location for that customer, the system flags it as an unknown location for mapping rather than failing opaquely. An authorized user resolves it by mapping the file value to an existing location, after which the row can validate and import.

**Why this priority**: Customer files routinely contain site names/codes that don't yet exist in master data; without a flag-and-map loop these rows are dead ends. Independently testable on top of US2.

**Independent Test**: Import a row whose origin code is not in master data and verify it is flagged as an unknown location for mapping (not auto-created, not silently dropped); map it to an existing location and verify the row then validates.

**Acceptance Scenarios**:

1. **Given** a row whose origin or destination does not match an active customer-scoped location, **When** validation runs, **Then** the location is flagged as **unknown for mapping** and the row cannot be created until resolved. *(LANE-005)*
2. **Given** a flagged unknown location, **When** an authorized user maps the file value to an existing location, **Then** the affected rows resolve and become eligible for import. *(LANE-005)*
3. **Given** an unknown location, **When** validation runs, **Then** the system never auto-creates the location nor silently drops the row. *(LANE-005)*

---

### User Story 5 - Review import batch history (Priority: P3)

An authorized user opens the import batch history to see every past import for auditing and follow-up: file name, user, timestamp, customer, row counts, outcome counts, and status, with access to the batch's error report and original file reference.

**Why this priority**: Operational traceability and troubleshooting; valuable but not required to perform an import. Independently testable.

**Independent Test**: Perform several imports and verify each appears in the history with correct metadata and counts and that the original file and error report remain retrievable.

**Acceptance Scenarios**:

1. **Given** prior imports, **When** an authorized user opens import batch history, **Then** each batch lists file name, user, timestamp, customer, total rows, and outcome counts (new / updated / duplicate / error) with its status. *(INT-004, §15.3)*
2. **Given** a historical batch, **When** the user opens it, **Then** the original uploaded file and the batch's error report (if any) are retrievable, and per-row references are preserved. *(INT-004, §19.1, STACK §3.12)*

---

### User Story 6 - Manually create a trip for exceptions (Priority: P3)

For ad-hoc trips, exceptions, or when a customer file cannot be processed, an authorized user creates a single trip manually using the same internal trip model, producing the same trip lifecycle and audit trail as an imported trip.

**Why this priority**: A necessary safety valve so operations never stall on a file failure, but it is the exception path rather than the primary intake. Independently testable.

**Independent Test**: Create a trip manually with the required fields and verify it is created in Received status through the shared trip domain with a full audit entry, not linked to any import batch.

**Acceptance Scenarios**:

1. **Given** an authorized user, **When** they manually enter the required trip fields (customer, origin, destination, planned windows, vehicle type, optional external trip ID), **Then** a trip is created in **Received** status through the shared trip domain with an audit entry. *(INT-007, slice 003)*
2. **Given** a manual trip with an external trip ID that already exists for the customer, **When** it is saved, **Then** the same match/update/no-op semantics apply as for an imported row. *(INT-007, §19.1)*

---

### Edge Cases

- **Empty or header-only file**: the batch is created and reports zero data rows with a clear message; nothing is created.
- **Unparseable / corrupt / wrong-type file**: the batch fails with a clear parsing error; no partial trips are created; the original file is retained.
- **Wrong template for the file** (columns don't match the mapping): rows fail mapping/validation with a clear message rather than producing garbage trips.
- **Duplicate external trip IDs within the same file**: every row sharing the same `(customer, external trip ID)` is flagged as an **Error (in-file collision)** and none of them are created until the file is corrected — no arbitrary first/last-wins; the system never persists two trips with the same `(customer, external trip ID)`.
- **Origin equals destination** on a row: rejected as an Error (consistent with the shared trip domain constraint).
- **Vehicle type the customer uses but the system's fixed type set does not contain**: the row is flagged (Warning/Error per template config); a new internal vehicle type is a code change, never invented at import time.
- **Mixed outcomes in one file** (some new, some updated, some duplicate, some error): each row is classified independently and the summary reflects all four counts.
- **Partial confirmation / re-confirmation**: confirmation is **per-row best-effort and idempotent** — rows that fail are reported in the batch counts/error report and retried on re-run, and re-running confirmation never double-creates trips.
- **Customer inactive/archived** at import time: rows for that customer fail validation with a clear message.
- **Concurrent re-import of the same plan**: matching on `(customer + external trip ID)` plus the trip's uniqueness guarantee prevents duplicate creation under races.
- **Update blocked by review gate**: a row targeting a trip past Confirmed without authorized review is reported (not silently dropped) so the user can request review.

---

## Requirements *(mandatory)*

### Functional Requirements

**Import engine & templates (CUST-003, INT-002, INT-003)**

- **FR-001**: System MUST use **one shared import engine driven by per-customer template configuration**; a separate importer per customer (code package or per-customer code branch) MUST NOT be created. *(CUST-003, INT-002; Constitution V; STACK §3.12, §7)*
- **FR-002**: Authorized users MUST be able to configure customer-specific import templates, including: file type (CSV/XLSX), column mappings (source column → internal trip field), date/number parsing rules (formats, timezone, decimal/thousand separators), required-field overrides, a status-mapping reference, and active status. *(CUST-003, INT-002; PRD §14.1 Import Template)*
- **FR-003**: System MUST map customer file fields into the internal trip model: external trip ID, customer, origin, destination, lane (when resolvable), planned pickup window (start/end), planned delivery window (start/end), planned vehicle type, planned volume/weight/pallet count, planned route notes, and customer service requirements. *(INT-003; PRD §14.1 Trip)*
- **FR-003a**: Templates MUST support versioning and active/inactive status so a customer's format can change over time without losing prior configuration or history. *(CUST-003)*
- **FR-004**: System MUST resolve customer-specific status labels to the internal standard statuses via the **Status Mapping** configuration referenced by the template, for **recording and validation only**: every imported trip is created in **Received** and import MUST NOT drive status transitions from the file (status changes are owned by dispatch (006) and execution (007)). Unmapped customer labels MUST be reported, never guessed. *(Decision §30; PRD §12, §14.1 Status Mapping; Clarification 2026-05-30)*
- **FR-005**: System MUST normalize customer-provided dates and numbers explicitly per the template's parsing rules; implicit/ambiguous date parsing MUST NOT be used. *(STACK §3.5)*

**File upload, batches & async processing (INT-001, INT-004)**

- **FR-006**: Authorized users MUST be able to upload CSV or spreadsheet (XLSX) files for a selected customer. *(INT-001; PRD §15.3)*
- **FR-007**: Every upload MUST create an **import batch** record capturing file name, customer, uploaded-by user, upload timestamp, total rows, created/updated/duplicate/error counts, batch status, and a reference to the error report. *(INT-004; PRD §14.1 Import Batch)*
- **FR-008**: System MUST preserve the **original uploaded file** and **per-row references** for every batch so any imported or rejected trip can be traced back to its source row. *(STACK §3.12; §19.1)*
- **FR-009**: System MUST perform file parsing, row validation, duplicate detection, error-report generation, and import confirmation as **background worker jobs** on the Postgres-backed queue, not inside request/response handlers; the Trip Import screen MUST reflect batch progress via **polling** (no Realtime). *(STACK §2, §3.11; Constitution tech constraints)*
- **FR-010**: Background jobs MUST be idempotent where practical, record progress, and record useful error messages; the import batch MUST carry a durable status in Postgres. *(STACK §3.11)*

**Validation (§11.2, INT-006)**

- **FR-011**: System MUST validate each row, checking at least: customer exists and is active; external trip ID present; origin and destination resolved (or flagged for review); pickup and delivery windows valid; vehicle type present and mappable; planned distance/transit time plausible when provided; required customer fields present; row is not a duplicate; and the row does not conflict with an already-accepted customer update. *(§11.2)*
- **FR-012**: System MUST classify each row outcome as **Valid**, **Warning** (proceeds with attention), or **Error** (cannot proceed until corrected). *(§11.2)*
- **FR-013**: System MUST present validation results in a **preview table** with per-row status, a row-level summary (new / updated / duplicate / error counts), and clear, localized (pt-BR) error messages. *(§11.1, §15.3, §23)*
- **FR-014**: Authorized users MUST be able to **export an error report** listing every failed row with its reason and original row reference. *(INT-006; PRD §15.3)*
- **FR-015**: Authorized users MUST be able to **resolve import errors** (e.g., correct mappings, map unknown locations, fix source data) and re-validate or re-import. *(INT-006)*
- **FR-016**: On confirmation, System MUST apply only **Valid** and **Warning** rows and MUST exclude **Error** rows. *(§11.2)*

**Matching, duplicates & update / no-op (INT-005, §19.1)**

- **FR-017**: System MUST match each row on **(customer + external trip ID)**. *(§19.1)*
- **FR-017a**: When a single file contains multiple rows sharing the same **(customer + external trip ID)**, System MUST flag all such rows as **Error (in-file collision)** and create none of them until corrected; it MUST NOT silently pick a first/last winner. *(Clarification 2026-05-30)*
- **FR-018**: When no existing trip matches, System MUST create a new trip. *(§19.1)*
- **FR-019**: When an existing trip matches and plan fields changed, System MUST **update** the trip's live planned fields through the shared trip domain, **preserve the original imported plan**, and record the change as an audited customer update. *(§19.1; slice 003)*
- **FR-020**: When an existing trip matches and data is identical, System MUST treat the row as a **no-op** and report it as **unchanged** — never a new trip. *(§19.1)*
- **FR-021**: A repeated external trip ID MUST be treated as an update or no-op and MUST NEVER be treated as a blocking duplicate. *(§19.1; Decision §30)*
- **FR-022**: System MUST flag **potential (fuzzy) duplicates** — rows with no external-trip-ID match that match an existing trip on customer + origin + destination + pickup window + vehicle type within a **configurable tolerance** — for user review, and MUST allow their creation only with a **recorded reason**. *(INT-005, §19.1)*
- **FR-023**: The fuzzy-duplicate match tolerance MUST be **configurable with a documented default** (labeled scaffolding; final values pending real customer files). *(§19.1; Constitution II)*
- **FR-024**: When a matched trip is already past **Confirmed**, System MUST require **explicit authorized review** before applying an import-driven plan update, and MUST report (not silently drop) rows blocked by this gate. *(§19.1; slice 003 review-gate)*

**Locations (LANE-005)**

- **FR-025**: System MUST identify **unknown locations** during import — an origin or destination that does not resolve to an active customer-scoped location — and **flag them for mapping**; it MUST NOT auto-create the location nor silently drop the row. *(LANE-005)*
- **FR-026**: Authorized users MUST be able to resolve a flagged unknown location by **mapping the file value to an existing active location** (creating new locations remains a master-data function of slice 002, out of scope here); the system MUST remember the (file value → location) alias so future imports auto-resolve the same value, after which affected rows become eligible for import. *(LANE-005; Clarification 2026-05-30)*

**Trip creation/update via the shared domain (slice 003 reuse)**

- **FR-027**: On confirmation, accepted rows MUST create or update trips **through the shared trip domain model** (the slice 003 create/update/transition services); new trips MUST land in **Received** status with the import batch reference populated. *(§19.1; slice 003 reuse contract)*
- **FR-027a**: Import confirmation MUST be **per-row best-effort and idempotent**: rows that persist successfully are applied, rows that fail (e.g., a concurrent conflict) are recorded in the batch outcome counts and error report, and re-running confirmation retries only the still-unapplied rows without duplicating already-created trips. *(STACK §3.11; Clarification 2026-05-30)*
- **FR-028**: System MUST NOT redefine the trip status machine, audit actions, or the billing-status projection; it MUST consume slice 003's definitions and never set billing status directly. *(slice 003 reuse contract)*
- **FR-029**: Import confirmation, and every resulting trip creation and customer update, MUST be recorded in the **append-only audit/event history** (with import as the recorded source); audit/import-batch records MUST NOT be hard-deleted. *(Constitution III/IV; STACK §5.4)*

**Manual creation (INT-007)**

- **FR-030**: Authorized users MUST be able to **manually create a trip** for exceptions, ad-hoc trips, or file failures, using the same internal trip model and producing the same lifecycle (Received) and audit trail; the same `(customer + external trip ID)` match/update/no-op semantics apply when an external trip ID is supplied. *(INT-007; §19.1)*

**Import batch history (INT-004)**

- **FR-031**: System MUST provide an **import batch history** view listing each batch's file name, user, timestamp, customer, total rows, outcome counts, and status, with access to the original file and error report. *(INT-004; §15.3)*

**Permissions (§18)**

- **FR-032**: Only **Admin** and **Ops Manager** roles MUST be permitted to upload files, configure templates, resolve errors, map locations, and confirm imports; enforcement MUST be in the BFF (RLS deferred), and the import path MUST NOT be exposed without authorization. *(PRD §18; STACK §5.3)*

---

### Key Entities *(include if feature involves data)*

- **Import Template**: Defines how one customer's file columns map into the internal trip model. Attributes: customer, name/version, file type (CSV/XLSX), column mappings (source column → internal field), date/number parsing rules (formats, timezone, separators), required-field overrides, status-mapping reference, active status. One engine, many configs. *(PRD §14.1; CUST-003, INT-002/003)*
- **Import Batch**: The durable record of one upload. Attributes: customer, file name, uploaded-by user, upload timestamp, total rows, created/updated/duplicate/error counts, batch status, error-report reference, original-file reference. *(PRD §14.1; INT-004)*
- **Status Mapping**: Maps a customer's status terminology to the internal standard statuses. Attributes: customer, customer label/code, internal status, active status. Referenced by the Import Template. Used at import for **recording/validation only** — import creates trips in Received and does not transition them from the file. *(PRD §14.1; Decision §30; Clarification 2026-05-30)*
- **Location Alias**: A remembered mapping from a customer's file location value to an existing customer-scoped Location, captured when an authorized user resolves a flagged unknown location, so subsequent imports auto-resolve the same value. Does not create master-data locations (slice 002 owns that). *(LANE-005; Clarification 2026-05-30)*
- **Import Row (staged result)**: The per-row working result tied to a batch — original row reference, raw source values, mapped internal values, validation outcome (Valid/Warning/Error) with reasons, and match decision (new / update / no-op / potential duplicate / unknown-location). Preserves original file/row references for traceability. *(STACK §3.12; §19.1)*
- **Trip** *(reused from slice 003 — not redefined here)*: Import populates the customer-plan subset — external trip ID, customer, origin, destination, optional lane, planned pickup/delivery windows, planned vehicle type, volume/weight/pallets, route notes, service requirements — and the import-batch reference. New trips land in **Received**; the **original plan is immutable after import**; later import-driven changes update only the live planned fields and are audited. *(slice 003; PRD §14.1)*
- **Customer / Location / Lane** *(reused from slice 002 — not redefined here)*: Resolution targets. Customer resolved by stable customer code; Location resolved by **(customer, code)** against active rows; Lane optionally matched by **(customer, origin, destination)**. Vehicle types map onto the fixed vehicle-type set. *(slice 002; CUST-003, LANE-005)*

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of uploads create a durable import batch record capturing file name, user, timestamp, customer, total rows, and the four outcome counts (new / updated / duplicate / error). *(INT-004)*
- **SC-002**: Re-importing an identical, previously imported file produces **zero** new trips and reports every matched row as **unchanged** (no-op). *(§19.1)*
- **SC-003**: 100% of rows that fail validation are reported with a clear, localized reason identifying the original row, and the full set is downloadable as an error report. *(§11.2, INT-006, §23)*
- **SC-004**: Operations can import a valid customer file (with a configured template) and have new trips appear in **Received** status end-to-end; a 1,000-row file is parsed, validated, and ready to confirm within 5 minutes via background processing. *(INT-001/002/003, §11.1)*
- **SC-005**: 100% of unknown origin/destination locations are flagged for mapping; none are silently dropped or auto-created. *(LANE-005)*
- **SC-006**: 100% of potential (fuzzy) duplicates are surfaced for review and can only be created with a recorded reason. *(INT-005, §19.1)*
- **SC-007**: The original uploaded file and per-row references are retrievable for 100% of import batches. *(§19.1, INT-004)*
- **SC-008**: Importing a large file never blocks or times out the user's screen; the user can navigate away and return to see progress and the final outcome. *(STACK — worker queue)*
- **SC-009**: 100% of import confirmations and resulting trip creations/updates appear in the append-only audit history with import recorded as the source. *(Constitution III/IV)*
- **SC-010**: Re-running confirmation after a partial failure creates zero duplicate trips and applies only the previously unapplied rows. *(Clarification 2026-05-30)*

---

## Traceability *(acceptance criteria → PRD)*

| Spec item | Maps to PRD ID / section | Notes |
|-----------|--------------------------|-------|
| US1; FR-001, FR-006, FR-007, FR-013, FR-027; SC-001, SC-004 | INT-001, INT-002, INT-003, INT-004; §11.1, §15.3 | Core upload → map → validate → confirm → create; one engine, many configs |
| US1/US2 templates; FR-002, FR-003, FR-003a, FR-005 | CUST-003, INT-002, INT-003; §13.1, §14.1 (Import Template) | Customer-specific template config; field mapping; explicit date/number parsing |
| FR-004 | §12 (status labels), §30 (Status Mapping); §14.1 (Status Mapping) | Customer status terms → internal standard statuses |
| US2; FR-011, FR-012, FR-013, FR-014, FR-015, FR-016; SC-003 | §11.2; INT-006; §15.3, §23 | Validation outcomes, error report, error resolution, Error rows excluded |
| US3; FR-017, FR-017a, FR-018–FR-024; SC-002, SC-006 | INT-005; §19.1; §30 (import semantics) | Match on (customer + external trip ID); update/no-op; fuzzy duplicate review; review gate past Confirmed; in-file collisions error out (Clarification 2026-05-30) |
| US4; FR-025, FR-026; SC-005 | LANE-005; §13.2 | Unknown locations flagged for mapping, never auto-created; resolved by alias to existing location (Clarification 2026-05-30) |
| US5; FR-031; SC-007 | INT-004; §15.3, §19.1 | Import batch history; original file + row references preserved |
| US6; FR-030 | INT-007; §19.1 | Manual trip creation reuses the same domain + match semantics |
| FR-008, FR-009, FR-010; SC-008 | §11.1; STACK §2, §3.11/§3.12 | Original-file/row preservation; heavy work on worker queue; polling freshness |
| FR-027, FR-027a, FR-028, FR-029; SC-009, SC-010 | §19.1; §22 Phase 2; §23; slice 003 | Create/update through shared trip domain; audited; status machine reused, not redefined; confirmation per-row best-effort + idempotent (Clarification 2026-05-30) |
| FR-004; SC-009 | §12, §30; §14.1 (Status Mapping) | Customer status labels recorded/validated only; import does not transition trips (Clarification 2026-05-30) |
| FR-032 | §18 | Import restricted to Admin + Ops Manager; BFF-enforced |
| Scope (deferred) | §20.1, §22 Phase 2; INT-008, INT-009 | API ingestion and email-attachment ingestion are Later |

---

## Scope

### In scope

- CSV/XLSX file upload for a selected customer (INT-001).
- Customer-specific import templates: column mapping, date/number parsing, required-field overrides, status-mapping reference, versioning/active status (CUST-003, INT-002, INT-003).
- Status Mapping resolution of customer status labels to internal statuses.
- Row validation with Valid/Warning/Error outcomes, localized messages, preview table, error export, and error resolution (§11.2, INT-006).
- Duplicate handling: match on (customer + external trip ID); update/no-op semantics; fuzzy-duplicate flagging with recorded reason; review gate for trips past Confirmed (INT-005, §19.1).
- Unknown-location flagging and mapping (LANE-005).
- Import batches and import batch history; preservation of original file and row references (INT-004).
- Trip creation/update through the shared trip domain (new trips in Received), with import recorded in the audit/event history (slice 003 reuse).
- Manual trip creation for exceptions/ad-hoc/file failures (INT-007).

### Out of scope (owned elsewhere)

- **API-based trip ingestion** — INT-008; Later (§20.1, §22).
- **Scheduled email-attachment ingestion** — INT-009; Later (§20.1, §22).
- **Trip list, trip detail, control-tower board, dashboard** — slice 005 (TRIP-001..005, REP-001/005).
- **Dispatch / resource assignment** — slice 006 (DISP-001..009).
- **SLA calculation, execution events, exceptions, alerts** — slice 007.
- **Documents / proof of delivery** — slice 008.
- **Billing, rates, finance export** — slice 008.
- **Reporting / audit views / hardening** — slice 009.
- **Creating or editing master-data locations during import** — owned by slice 002; import only maps unknown file values to **existing** locations (LANE-005; Clarification 2026-05-30).
- **Driving trip status transitions from the imported file** — owned by slices 006/007; import creates trips in Received only (Clarification 2026-05-30).
- **Route optimization** — explicitly never (project non-goal).
- Defining the trip status machine, audit semantics, or master-data entities — owned by slices 003 and 002; this slice **reuses** them.

---

## Dependencies

- **Slice 001 (Platform, Access, App Shell)**: BFF auth context and role-aware permission checks, the critical-action audit helper, i18n (pt-BR), and the Next.js app shell that hosts the Trip Import screen.
- **Slice 002 (Master Data & Configuration)**: Customer (resolved by customer code), Location (resolved by customer + code, active only), Lane (matched by customer + origin + destination, optional on a trip), and the fixed vehicle-type set — all resolution targets for import.
- **Slice 003 (Trip Domain, Status Machine, Audit Semantics)**: the shared trip create/update/transition services, the `(customer + external trip ID)` uniqueness used for matching, the import-batch reference hook on the trip, the immutable original-plan vs. live-planned-fields separation, the **Received** initial status, the review gate for updates past Confirmed, and append-only trip events/audit logs. **Import calls these; it does not reimplement them.**
- **Platform/architecture (STACK + Constitution)**: Postgres-backed job queue + single Node worker for parsing/validation/duplicate-detection/error-report/confirmation; object storage for the original uploaded files with metadata in Postgres; shared validation schemas usable by web + worker; explicit date normalization; polling (no Realtime); BFF-only authorization (RLS deferred); service-role key server-only.

---

## Assumptions

- **Real customer sample files are a business-input gate (PRD §29 Input #1, Constitution II)**: Shopee, DHL eCommerce, and Mercado Livre sample files are **not yet available**. The import **engine and its tests are built against sample fixtures and documented defaults**, and per-customer template/status-mapping configurations use documented defaults **labeled as scaffolding**. Final per-customer template sign-off is **blocked** (see below). No customer-specific format detail is invented.
- **Roles**: Import upload, template configuration, error resolution, location mapping, and confirmation are restricted to **Admin** and **Ops Manager** (PRD §18); enforced in the BFF.
- **Resolution keys**: Customer resolved by stable customer code; Location resolved by (customer, code) against active rows; Lane optionally matched by (customer, origin, destination). Unresolved locations are flagged for mapping (LANE-005).
- **Vehicle types** map onto the fixed, code-defined vehicle-type set (slice 002); a customer vehicle-type value with no mapping is reported (Warning/Error per template), and adding a new internal vehicle type is a code change, not an import-time action.
- **Trip lifecycle**: Imported and manually created trips land in **Received**; import **never drives status transitions from the file** (Status Mapping records/validates the customer label only — transitions are owned by slices 006/007); the original imported plan is immutable; import never sets billing status (a derived projection). Status machine, audit actions, and billing projection are consumed from slice 003.
- **Async processing**: All heavy parsing/validation/duplicate-detection runs in the worker; the Trip Import screen and batch history use polling for freshness (no Realtime).
- **Configurable defaults (scaffolding)**: the fuzzy-duplicate match tolerance, required-field overrides, and status-mapping value sets are configuration with documented defaults; final values depend on real customer files.
- **Within-file duplicate external trip IDs**: all colliding rows are flagged as **Error** and none are created until corrected (no first/last-wins); the system never persists two trips with the same `(customer, external trip ID)`.
- **Import confirmation** is **per-row best-effort and idempotent**: a confirmation that partially fails applies the rows that succeeded, records the failures, and can be safely re-run to retry only the unapplied rows.
- **Unknown-location resolution** maps a file value to an **existing active location** and remembers the alias; creating master-data locations stays in slice 002.

---

## Blocked / Open for business sign-off

> Per Constitution Principle II and PRD §29, this slice's **final sign-off is BLOCKED** until the following business inputs are confirmed. The import engine, validation, duplicate handling, and tests are buildable now against sample fixtures and documented defaults; the items below cannot be finalized until real inputs arrive — and they MUST NOT be invented.

1. **Real customer sample files (PRD §29 Input #1)** — current-format files from **Shopee, DHL eCommerce, and Mercado Livre**. Gate: finalizing per-customer **import templates / column mappings / required-field overrides** (CUST-003, INT-002, INT-003) and the **import test fixtures**. Until supplied, customer configs are documented-default scaffolding.
2. **Per-customer Status Mapping value sets** — each customer's real status vocabulary, to map onto the internal standard statuses (§12, §30). Needs the sample files / customer confirmation.
3. **Fuzzy-duplicate match tolerance** — the configurable tolerance for the no-ID look-alike match on customer + origin + destination + pickup window + vehicle type (§19.1, FR-022/FR-023). Documented default in place; final values need Ops confirmation against real files.
4. **Unknown-location mapping workflow** — *behavior resolved* (Clarification 2026-05-30): import maps a flagged file value to an **existing active location** and remembers the alias; master-data location creation stays in slice 002. Only the fine-grained screen UX remains a routine 004 design detail (not a business-input gate).
