# Data Model: Predefined Import Template (slice 013)

**This slice adds NOTHING durable** — no new table, column, enum, index, or migration. The only "model"
introduced is an **in-code constant**. Existing entities are reused exactly as slice 004 defined them;
the only behavioral delta is that `import_batches.template_id` is now always `null` on the operator path.

## New: `STANDARD_IMPORT_TEMPLATE` (in-code constant, not persisted)

A single customer-agnostic `TemplateConfig` literal in `@brazil-tms/shared`
(`src/import/standard-template.ts`), reusing the slice-004 demo mapping (`packages/db/seed/import-sample.ts`)
**verbatim**. It is the only format applied to imports in this slice.

| Field | Value | Notes |
|-------|-------|-------|
| `customerId` | `"00000000-0000-0000-0000-000000000000"` | **Inert** — `applyTemplate` never reads it; nil UUID + comment "unused; format is customer-agnostic". |
| `name` | `"Padrão Brazil Transports (provisório)"` | Documentation/provisional label. |
| `version` | `1` | Inert. |
| `fileType` | `"csv"` | **Inert** — the parser is chosen from the uploaded file's extension (`inferFileType`), not this field. |
| `columnMappings` | see below | The real mapping consumed by `applyTemplate`. |
| `parsingRules` | `{ dateFormats: ["dd/MM/yyyy HH:mm"], timezone: "America/Sao_Paulo", decimalSeparator: ",", thousandSeparator: "." }` | Brazil defaults. |
| `requiredOverrides` | `[]` | **Empty** — no new required-column enforcement (R8); the validate worker's `loadRequiredOverrides(null)` already returns `[]`. |

**`columnMappings`** (source header → internal target; `required` flags are documentation only — the
engine ignores them, R8):

| source | target | required (doc only) |
|--------|--------|---------------------|
| `id_viagem` | `externalTripId` | yes |
| `origem` | `originCode` | yes |
| `destino` | `destinationCode` | yes |
| `janela_coleta_inicio` | `plannedPickupWindowStart` | — |
| `janela_coleta_fim` | `plannedPickupWindowEnd` | — |
| `janela_entrega_inicio` | `plannedDeliveryWindowStart` | — |
| `janela_entrega_fim` | `plannedDeliveryWindowEnd` | — |
| `tipo_veiculo` | `plannedVehicleType` | — |
| `status` | `statusLabel` | — |

**Validation rule**: the literal MUST parse against `templateConfigSchema` (asserted once in a unit test),
so a malformed edit fails fast rather than at runtime.

**Provisional posture**: this is a **§29-blocked documented default** (per-customer file rules not signed
off). It is surfaced to operators via the upload-screen provisional banner and is **not** a sign-off of a
real customer format. Swapping in a real signed-off format is a single-object edit (FR-010 / SC-007).

## Reused, unchanged entities (slice 004)

### `import_batches`
- Schema unchanged. `template_id uuid NULL` (FK → `import_templates`) — on the operator path it is now
  **always null** (the client sends no `templateId`; `createBatch` stores `templateId ?? null`). No new
  column (notably **no** `file_type` column — the worker infers type from `file_name`).
- Lifecycle unchanged: `received → parsing → validating → validated → confirming → completed` (or
  `failed`). The parse stage no longer sets `failed` for "no template" (that branch is replaced by the
  constant fallback).

### `import_templates`
- Schema unchanged; table **dormant** on the operator path (not read by parse when `template_id` is null).
  Retained — with its list/detail/create/update/archive endpoints — for future signed-off per-customer
  configs. Not removed, not migrated.

### `import_rows`
- Unchanged. `outcome ∈ {valid, warning, error}` + structured pt-BR `reasons[]` produced exactly as in
  slice 004 (the standard format feeds the same `applyTemplate` → validate path).

### Mapped trip fields
- The closed internal target set is unchanged (`externalTripId`, `originCode`, `destinationCode`,
  planned pickup/delivery windows, `plannedVehicleType`, `statusLabel`, plus the numeric/json planned
  fields). The standard format maps the subset above; others remain null, as today.

## State / flow delta (summary)

```text
Upload (Cliente + Arquivo)  ──►  createBatch (templateId = null)  ──►  parse
                                                                        │
                  templateId == null  ──►  use STANDARD_IMPORT_TEMPLATE (constant)   ◄── NEW
                  templateId  != null  ──►  load row + toTemplateConfig (existing, API-only path)
                                                                        │
                       parser chosen by inferFileType(batch.fileName)   ◄── NEW (was template.fileType)
                                                                        │
                                              validate → detect-duplicates → (error report) → confirm
                                              (ALL UNCHANGED — validate already null-handles templateId)
```

No durable additions. No migration.
