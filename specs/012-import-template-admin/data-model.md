# Phase 1 Data Model: Import Template Administration

## Data-model delta: **NONE**

This slice **creates and modifies no durable schema**. No table, column, enum, index, constraint, or
migration is added. Everything below already exists and is **reused unchanged**; it is documented here so
the UI and tests bind to the exact shapes.

> Source of truth: `packages/db/schema/import-templates.ts` (table), `packages/shared/src/schemas/import.ts`
> (`templateConfigSchema`, `columnMappingSchema`, `parsingRulesSchema`, `MAPPED_*_FIELDS`), and
> `apps/web/lib/imports/import-templates-service.ts` (`ImportTemplateDto`).

## Entity (existing): Import Template

`import_templates` — per-customer, config-driven import mapping. Unique natural key
**`(customer_id, name, version)`**. Soft-delete via nullable `archived_at`.

| Field | Type | Notes (existing) |
|---|---|---|
| `id` | uuid | PK |
| `customerId` | uuid | FK → customers; the scope the screen operates within |
| `name` | text | part of the natural key |
| `version` | integer ≥ 1 | part of the natural key; **user-managed**, form suggests `max+1` |
| `fileType` | enum `csv` \| `xlsx` | CHECK-constrained in the DB |
| `columnMappings` | jsonb (`ColumnMapping[]`, min 1) | source-header → recognized target |
| `parsingRules` | jsonb (`ParsingRules`) | date formats, timezone, decimal/thousand separators |
| `requiredOverrides` | jsonb (`string[]`) | template-level extra-required field names |
| `active` | boolean (default true) | gates appearance in the Trip Import selector |
| `archivedAt` | timestamptz \| null | soft-delete; `archived = archivedAt !== null` in the DTO |
| `createdAt` / `updatedAt` | timestamptz | audit timestamps; **no revision/etag token** |

**API DTO** (`ImportTemplateDto`, returned by the endpoints): the above with `archived: boolean` (derived
from `archivedAt`) and ISO-string timestamps. **No `version`/`updatedAt` is usable as an optimistic-lock
token** → concurrent edits are last-write-wins (Out of Scope to change).

### Value object (existing): ColumnMapping

| Field | Type | Notes |
|---|---|---|
| `source` | string (min 1) | the literal column header in the customer's file |
| `target` | string (min 1) | **must** be a recognized internal field (UI constrains; see below) |
| `required` | boolean (optional) | per-mapping required flag |

> The shared `columnMappingSchema` only enforces non-empty `source`/`target`. It does **not** forbid a
> duplicate `target` nor validate `target` against the recognized set — these are **UI-only** rules added
> in the form's `.superRefine` (see `research.md`); the engine silently ignores an unrecognized target.

### Value object (existing): ParsingRules

| Field | Type | Default |
|---|---|---|
| `dateFormats` | string[] | `[]` |
| `timezone` | string | `America/Sao_Paulo` |
| `decimalSeparator` | string | `,` |
| `thousandSeparator` | string | `.` |

## Recognized target-field catalog (drives the grouped picker)

The target single-select is grouped by kind, options spread from the shared `MAPPED_*_FIELDS` (single
source of truth — the engine uses these to coerce cells). Group **headers** are pt-BR i18n labels; the
**option values** are the field identifiers below (never hardcoded — imported from `@brazil-tms/shared`).
The control is a **manually composed** grouped single-select (`SelectGroup` / `SelectLabel` / `SelectItem`)
— the shadcn `Select` has no `groups` prop (see `research.md` gotchas). The API DTO exposes a derived
`archived: boolean` (not the raw `archivedAt` column).

| Kind (pt-BR header) | Shared set | Target fields |
|---|---|---|
| **Texto** | `MAPPED_STRING_FIELDS` | `externalTripId`, `originCode`, `destinationCode`, `statusLabel`, `plannedVehicleType`, `plannedRouteNotes` |
| **Data e Hora** | `MAPPED_DATE_FIELDS` | `plannedPickupWindowStart`, `plannedPickupWindowEnd`, `plannedDeliveryWindowStart`, `plannedDeliveryWindowEnd` |
| **Número** | `MAPPED_NUMBER_FIELDS` | `plannedVolumeUnits`, `plannedWeightKg`, `plannedPalletCount`, `plannedDistanceKm`, `plannedTransitTimeMinutes` |
| **Estruturado** | `MAPPED_JSON_FIELDS` | `plannedServiceRequirements` |

## Lifecycle / state (existing semantics, surfaced by the UI)

- **Create** → new row (status `active`, `archivedAt` null). Duplicate `(customer, name, version)` →
  `DUPLICATE_TEMPLATE` 409.
- **Edit (non-archived)** → in-place update of config fields (single-purpose; does not branch versions).
- **New version** → a *create* with `version = max+1` (UI pre-fills; reuses the create path).
- **Activate / Deactivate** → toggles `active`; only `active && !archived` templates appear in the Trip
  Import selector.
- **Archive** → sets `archivedAt` (soft-delete; terminal in this slice — no un-archive). Archived rows are
  hidden by default and **not editable (UI-enforced)**.
- **Audit** → `import_template.create` / `import_template.update` rows are written by the existing service
  in the same transaction; the UI makes no audit call.

## UI-only validation rules (no schema change)

These live in the form's `.superRefine` over `templateConfigSchema` and/or as extracted `lib` helpers
(unit-tested):

1. **No duplicate target** across mapping rows — blocks save with an inline pt-BR hint (FR-002).
2. **At least one mapping** — already enforced by `columnMappingSchema.min(1)`; surfaced inline.
3. **Date target without a date format** — non-blocking pt-BR warning when a `MAPPED_DATE_FIELDS` target is
   mapped but `parsingRules.dateFormats` is empty (FR-015).
