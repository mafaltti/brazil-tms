# Phase 1 Data Model: Trip Import, Templates, Validation, and Duplicate Handling

**Feature**: 004-trip-import-validation | **Spec**: [spec.md](./spec.md) · **Research**: [research.md](./research.md)

Conventions (inherited from features 001/002/003, STACK §3.7): all tables live in `public`, `snake_case`, UUID PKs
(`gen_random_uuid()`; `defaultRandom()` in Drizzle), `created_at`/`updated_at` as `timestamptz NOT NULL DEFAULT now()`
(`updated_at` set manually by services), timestamps stored UTC (displayed `America/Sao_Paulo`), money integer centavos
(BRL). Soft-delete is a nullable `archived_at` (no hard delete of auditable/config records — Constitution III). DDL
blocks below are design sketches; the authoritative SQL is the `drizzle-kit generate` output committed under
`packages/db/migrations/`, **plus** a hand-added `ALTER TABLE trips ADD CONSTRAINT … FOREIGN KEY (import_batch_id)` to
activate 003's forward hook. Binary files (original upload, error report) live in **Supabase Storage**; only their keys
live here (STACK §3.9). Customer-provided dates/numbers are normalized **explicitly** (Luxon) before storage — never via
implicit JS `Date` (STACK §3.5).

## Enums (extend `packages/db/schema/enums.ts`)

```sql
CREATE TYPE import_batch_status AS ENUM (
  'received',     -- file uploaded to Storage; parse job enqueued
  'parsing',      -- worker reading the file into import_rows
  'validating',   -- per-row validation + duplicate detection running
  'validated',    -- preview ready; awaiting user confirmation        (R3 pipeline tail)
  'confirming',   -- confirm-import job applying accepted rows
  'completed',    -- confirmation finished (counts final)
  'failed'        -- unrecoverable parse/processing error (error_message set)
);                                                              -- R3

CREATE TYPE import_row_outcome AS ENUM ('valid', 'warning', 'error');   -- §11.2, FR-012

CREATE TYPE import_row_match  AS ENUM (
  'new',                 -- no (customer, external_trip_id) match → create
  'update',              -- match with changed plan fields → updateTripPlan
  'no_op',               -- match, identical data → reported unchanged
  'potential_duplicate', -- no external-id match; fuzzy match → review + recorded reason
  'unresolved'           -- error/blocked (unknown location, in-file collision, validation error)
);                                                              -- R7, FR-017..FR-024
```

> **Documented defaults (scaffolding — Constitution II)**: the fuzzy-duplicate **tolerance** used to assign
> `potential_duplicate`, the per-customer **status-mapping** value sets, and **required-field overrides** are config with
> documented defaults; final values are BLOCKED on real customer files (PRD §29). They are config, not enum values.

## 1. Import Template  (`public.import_templates`) — CUST-003, INT-002/003

One per-customer file-mapping configuration. **One engine, many configs** (Constitution V); the mapping engine
(`@brazil-tms/shared/import/engine.ts`) is driven by this row, never by per-customer code.

| Field | Type | Rules |
|---|---|---|
| id | uuid PK | `gen_random_uuid()` |
| customer_id | uuid FK → customers | NOT NULL (002) |
| name | text | NOT NULL |
| version | integer | NOT NULL DEFAULT 1 |
| file_type | text | NOT NULL; CHECK in (`'csv'`,`'xlsx'`) |
| column_mappings | jsonb | NOT NULL; `[{ source, target, required? }]` — source column → internal trip field (Zod-validated) |
| parsing_rules | jsonb | NOT NULL DEFAULT `{}`; date formats, timezone, decimal/thousand separators (Luxon) |
| required_overrides | jsonb | NOT NULL DEFAULT `[]`; internal fields forced required for this customer (**BLOCKED default**) |
| active | boolean | NOT NULL DEFAULT true |
| archived_at | timestamptz | nullable (soft-delete) |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() |

```sql
CREATE TABLE public.import_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  name text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  file_type text NOT NULL CHECK (file_type IN ('csv','xlsx')),
  column_mappings jsonb NOT NULL,
  parsing_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  required_overrides jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, name, version)
);
```

**Status-mapping reference**: resolved by `customer_id` against `status_mappings` (§4) — no explicit FK needed; the PRD's
"status-mapping reference" is per-customer. **Versioning**: a new format ships as a new `version` (active toggled);
history is preserved (FR-003a).

## 2. Import Batch  (`public.import_batches`) — INT-004

The durable record of one upload (the queue's "progress" anchor, STACK §3.11).

| Field | Type | Rules |
|---|---|---|
| id | uuid PK | `gen_random_uuid()` |
| customer_id | uuid FK → customers | NOT NULL |
| template_id | uuid FK → import_templates | nullable (selected/detected) |
| file_name | text | NOT NULL |
| storage_key | text | NOT NULL; key of the **original** file in Storage (R12) |
| uploaded_by | uuid FK → users | NOT NULL |
| status | import_batch_status | NOT NULL DEFAULT `'received'` |
| total_rows | integer | NOT NULL DEFAULT 0 |
| created_count | integer | NOT NULL DEFAULT 0 |
| updated_count | integer | NOT NULL DEFAULT 0 |
| duplicate_count | integer | NOT NULL DEFAULT 0 |
| error_count | integer | NOT NULL DEFAULT 0 |
| error_report_storage_key | text | nullable; key of the generated error report (R12) |
| error_message | text | nullable; set when `status = 'failed'` |
| created_at (= uploaded_at) / updated_at | timestamptz | NOT NULL DEFAULT now() |

```sql
CREATE TABLE public.import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  template_id uuid REFERENCES public.import_templates(id),
  file_name text NOT NULL,
  storage_key text NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES public.users(id),
  status import_batch_status NOT NULL DEFAULT 'received',
  total_rows integer NOT NULL DEFAULT 0,
  created_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  error_report_storage_key text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_batches_customer_idx ON public.import_batches(customer_id);
CREATE INDEX import_batches_created_idx  ON public.import_batches(created_at DESC);
```

**Counts** are mutable operational progress (not an append-only audit record); the immutable trace is `import_rows.raw`
+ the original file in Storage. Batches are **never hard-deleted** (Constitution III).

## 3. Import Row  (`public.import_rows`) — staging (R6); preserves original row refs (STACK §3.12)

| Field | Type | Rules |
|---|---|---|
| id | uuid PK | `gen_random_uuid()` |
| import_batch_id | uuid FK → import_batches | NOT NULL, ON DELETE CASCADE |
| row_number | integer | NOT NULL; **original 1-based file row** (traceability) |
| raw | jsonb | NOT NULL; verbatim source cells (immutable once written) |
| mapped | jsonb | nullable; engine output (internal trip fields), set during parse/validate |
| outcome | import_row_outcome | nullable until validated |
| reasons | jsonb | NOT NULL DEFAULT `[]`; `[{ code, field?, message }]` (localized messages, error/warning detail) |
| match_decision | import_row_match | nullable until duplicate-detection runs |
| target_trip_id | uuid FK → trips | nullable; set on apply (links row → created/updated trip) |
| applied_at | timestamptz | nullable; set when the row is applied (idempotency guard, R8) |
| created_at | timestamptz | NOT NULL DEFAULT now() |

```sql
CREATE TABLE public.import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id uuid NOT NULL REFERENCES public.import_batches(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  raw jsonb NOT NULL,
  mapped jsonb,
  outcome import_row_outcome,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  match_decision import_row_match,
  target_trip_id uuid REFERENCES public.trips(id),
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (import_batch_id, row_number)
);
CREATE INDEX import_rows_batch_outcome_idx ON public.import_rows(import_batch_id, outcome);
```

## 4. Status Mapping  (`public.status_mappings`) — Decision §30; record/validate only (R10)

Maps a customer's status terminology to internal `trip_status`. Used at import for **recording/validation only** — import
creates trips in `received` and never transitions from the file.

| Field | Type | Rules |
|---|---|---|
| id | uuid PK | `gen_random_uuid()` |
| customer_id | uuid FK → customers | NOT NULL |
| customer_label | text | NOT NULL; the customer's status string |
| internal_status | trip_status | NOT NULL (003 enum) |
| active | boolean | NOT NULL DEFAULT true |
| archived_at | timestamptz | nullable |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() |

```sql
CREATE TABLE public.status_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  customer_label text NOT NULL,
  internal_status trip_status NOT NULL,
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, customer_label)
);
```

> **BLOCKED default**: per-customer status vocabularies need real files (PRD §29). Seed with a documented default mapping
> (e.g., common labels → `received`), labeled scaffolding.

## 5. Location Alias  (`public.location_aliases`) — LANE-005 (R11)

Remembers a resolved unknown-location mapping so future imports auto-resolve it. **Does not create master-data
locations** (slice 002 owns that).

| Field | Type | Rules |
|---|---|---|
| id | uuid PK | `gen_random_uuid()` |
| customer_id | uuid FK → customers | NOT NULL |
| file_value | text | NOT NULL; the customer's location string/code from the file |
| location_id | uuid FK → locations | NOT NULL; the existing active location it maps to |
| created_by | uuid FK → users | NOT NULL |
| created_at | timestamptz | NOT NULL DEFAULT now() |

```sql
CREATE TABLE public.location_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  file_value text NOT NULL,
  location_id uuid NOT NULL REFERENCES public.locations(id),
  created_by uuid NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, file_value)
);
```

## 6. Trip forward-hook activation (`public.trips.import_batch_id`) — 003 hook

003 left `trips.import_batch_id uuid` nullable with **no FK** ("import batches owned by 004"). 004 adds the FK:

```sql
-- hand-added after drizzle-kit generate (it won't infer the cross-feature FK reliably):
ALTER TABLE public.trips
  ADD CONSTRAINT trips_import_batch_id_fk
  FOREIGN KEY (import_batch_id) REFERENCES public.import_batches(id);
```

`createTrip` already accepts `importBatchId` (003 `createTripSchema`); the confirm job passes the batch id so every
imported trip links back to its batch (traceability). Manually created trips (US6) leave it null.

## Append-only / immutability notes

- `audit_logs` (reused) and `trip_events` (`source='import'`) remain append-only (003's `REVOKE UPDATE, DELETE`); 004 adds
  no new append-only table. `import_rows.raw` is treated as **write-once** by the services (never updated after parse).
- Original upload + error report are immutable objects in Storage. Templates/status-mappings/location-aliases archive via
  `archived_at` (no hard delete). Batches are retained (no delete).

## Relationships

```text
customers (002) 1───* import_templates        customers 1───* status_mappings
customers (002) 1───* import_batches *───1 import_templates (nullable)
import_batches  1───* import_rows  *───0..1 trips (target_trip_id)
customers (002) 1───* location_aliases *───1 locations (002)
import_batches  1───* trips (trips.import_batch_id, nullable)   ← 003 forward hook, FK added here
users (001)     1───* import_batches (uploaded_by) / location_aliases (created_by)
```

## Import lifecycle (batch + row) — the pipeline (R3)

```text
upload ──(BFF: Storage put + batch row + enqueue)──▶ received
received ──parse job──▶ parsing ──(import_rows raw+mapped)──▶ enqueue validate
parsing  ──validate job──▶ validating ──(outcome+reasons per row)──▶ enqueue detect-duplicates
validating ──detect-duplicates job──▶ (match_decision per row; errors → enqueue generate-error-report) ──▶ validated
validated ──user confirm (BFF enqueue)──▶ confirming ──confirm-import job (per-row best-effort, idempotent)──▶ completed
any stage hard failure ──▶ failed (error_message set; original file retained)
```

Row outcomes drive apply: `valid` + (`new`|`update`|`no_op`) and `warning` (incl. `potential_duplicate` with recorded
reason) are applied on confirm; `error` (incl. `unresolved`: unknown location, in-file collision, validation failure) is
excluded until corrected. Imported trips land in `received`; import never transitions status (R10).

## Audit actions (extend `packages/shared/src/audit/actions.ts`)

```typescript
export type AuditAction =
  | /* …001/002/003 actions… */
  | 'import.create'             // batch uploaded (entityType 'import_batch')
  | 'import.confirm'            // batch confirmed (entityType 'import_batch')
  | 'import_template.create'
  | 'import_template.update'
  | 'status_mapping.upsert'
  | 'location_alias.create';
// Per-trip 'trip.create' / 'trip.plan_update' (003) also fire during confirm, with reason referencing the batch id.
```

## Validation rules (Zod — `packages/shared/src/schemas/import.ts`; engine — `…/import/*`)

- **`templateConfigSchema`**: `file_type ∈ {csv,xlsx}`; `column_mappings` non-empty, each `{ source, target ∈ internal
  fields, required? }`; `parsing_rules` (date format(s), zone default `America/Sao_Paulo`, decimal/thousand separators);
  `required_overrides ⊆ internal fields`. Reused by the web admin UI **and** the worker (re-validate on load).
- **`uploadMetaSchema`**: `{ customerId: uuid, templateId?: uuid, fileName, fileType ∈ {csv,xlsx} }`.
- **`mappedRowSchema`**: the engine output → the subset of 003's `createTripSchema` fields (external trip id, origin/
  destination codes, planned windows, vehicle type, volume/weight/pallets, route notes, service requirements). Engine
  (`applyTemplate`) is **pure**; `normalize` does **explicit Luxon** date/number parsing (no implicit `Date`).
- **Row validation (worker)**: customer active; `external_trip_id` present; origin/destination resolve to active
  `(customer, code)` locations **or** a `location_alias`, else `unknown_location`; pickup/delivery windows valid &
  ordered; `planned_vehicle_type` maps to the fixed `vehicle_type` enum (unmappable → warning/error per template);
  required (+ overrides) present; not an in-file collision. Outcome ∈ {valid, warning, error} with localized `reasons`.
- **Duplicate decision (worker)**: see R7 — match on `(customer_id, external_trip_id)`; fuzzy tolerance is config
  (documented default, BLOCKED); in-file collision → all error.
- **Confirm (worker, R8)**: calls promoted `createTrip` / `updateTripPlan`; `REVIEW_REQUIRED` (past `confirmed`) →
  row needs-review; idempotent via `(import_batch_id, row_number)` + `applied_at`.
