# API Contracts — 016 Freight Rate Lookup

House envelope: success `{ items }` / `{ item }`; error
`{ error: { code, message, issues? } }` via `handleRouteError`. All routes
`dynamic = "force-dynamic"`, `requireAuth()` first.

## GET /api/freight-rates — `view_freight_rates`

Query params (all optional, Zod `freightRateFilterSchema`):

| param | type | semantics |
|---|---|---|
| originUf | string(2) | exact, uppercased |
| originCity | string | exact match (value came from dataset) |
| destinationUf | string(2) | exact |
| destinationCity | string | exact |
| priceMinCents | int ≥ 0 | valor_ida_cents ≥ min (rows with null valor_ida excluded when either bound present) |
| priceMaxCents | int ≥ 0 | valor_ida_cents ≤ max |
| sort | `"valorIda" \| "km"` | asc, nulls last; omitted = route order (originUf, originCity, destUf, destCity, id) |

`200 { items: FreightRateItem[] }` where `FreightRateItem = { id, originUf,
originCity, destinationUf, destinationCity, km, vehicleType, valorIdaCents,
valorReversaCents, observacoes }` (nulls preserved). No pagination (≤ ~500 rows).

Errors: 401 / 403; 400 VALIDATION (bad params).

## POST /api/freight-rates/import — `import_freight_rates`

`multipart/form-data` with `file` (.xlsx). Behavior: parse sheet
`Controle de Fretes` → shared normalizer → on success REPLACE ALL in one
transaction (delete freight_rates; insert rates; insert freight_rate_imports;
`writeAudit` entityType `freight_rate_import`, action `replace`, newValue
`{ fileName, routeCount, rateCount }`).

- `201 { item: { id, fileName, routeCount, rateCount } }`
- `409 { error: { code: "INVALID_FILE", message (pt-BR) }, findings: [{ row, column, message }] }`
  — nothing changed (house envelope: Conflict details surface as top-level `findings`)
- `409 NO_FILE` / `409 UNSUPPORTED_FILE_TYPE` (not .xlsx)
- 401 / 403 otherwise

## Freshness (FR-008)

Client hook polls GET with `refetchInterval: 30_000` (house board convention);
upload mutation invalidates `["freight-rates"]` immediately for the uploader.
