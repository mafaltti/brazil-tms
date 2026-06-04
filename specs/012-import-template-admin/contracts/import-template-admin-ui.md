# Contract: Import Template Admin — UI ↔ BFF

**No new endpoint is created by this slice.** The screen consumes the **existing, frozen** import-template
endpoints (shipped in Feature 004). This file documents the contract the new UI binds to, so the client
module and e2e assertions match reality exactly.

Source: `apps/web/app/api/import-templates/route.ts`, `.../[id]/route.ts`,
`apps/web/lib/imports/import-templates-service.ts`. All gated by **`import_trips`** (Admin + Operations
Manager). Envelopes: success `{ items }` / `{ item }`; error `{ error: { code, message } }` via
`handleRouteError`.

## GET /api/import-templates?customerId=&includeArchived=

- **Auth**: `import_trips` (else 403). 401 if unauthenticated.
- **Query**: `customerId` (uuid, optional — the screen always sends it); `includeArchived=true|false`
  (default false → excludes `archived_at IS NOT NULL`).
- **200**: `{ items: ImportTemplateDto[] }` ordered newest-first.
- **UI use**: the per-customer list; the `includeArchived` toggle; the source for the last-active count and
  the `max(version)` computation.

## POST /api/import-templates

- **Auth**: `import_trips`.
- **Body**: `TemplateConfig` (`customerId`, `name`, `version`, `fileType`, `columnMappings[]` (min 1),
  `parsingRules`, `requiredOverrides`). Re-validated server-side by `templateConfigSchema`.
- **201**: `{ item: ImportTemplateDto }`.
- **409**: `{ error: { code: "DUPLICATE_TEMPLATE", message: "Já existe um modelo com esse nome e versão." } }`
  on a duplicate `(customerId, name, version)`.
- **400**: Zod validation failure (envelope per `handleRouteError`).
- **UI use**: Create, and "Criar nova versão" (same endpoint, `version = max+1`).

## GET /api/import-templates/:id

- **Auth**: `import_trips`.
- **200**: `{ item: ImportTemplateDto }`. **404**/Conflict `NOT_FOUND` if missing.
- **UI use**: open a template for edit / read-only inspection.

## PATCH /api/import-templates/:id

- **Auth**: `import_trips`. *(Archive is gated by `import_trips` here — NOT `delete_archive`. The UI must
  match this gate; see `research.md` Authorization decision.)*
- **Body** (`templateConfigSchema.partial()` + `{ active?: boolean, archive?: boolean }`): any subset of
  config fields to edit; `active` to activate/deactivate; `archive: true` to soft-delete (`archived_at`).
- **200**: `{ item: ImportTemplateDto }`.
- **409**: `DUPLICATE_TEMPLATE` if an edit collides with another `(customer, name, version)`.
- **UI use**: edit (config fields), activate/deactivate (`{active}`), archive (`{archive:true}`).
- **⚠ Not guarded server-side**: a config PATCH on an **archived** row is accepted by the backend. The UI
  enforces "archived = not editable" by hiding the edit/activate/deactivate/archive actions (FR-010).

## ImportTemplateDto (response shape)

```jsonc
{
  "id": "uuid",
  "customerId": "uuid",
  "name": "string",
  "version": 1,
  "fileType": "csv" | "xlsx",
  "columnMappings": [{ "source": "string", "target": "string", "required": true }],
  "parsingRules": { "dateFormats": ["dd/MM/yyyy HH:mm"], "timezone": "America/Sao_Paulo",
                    "decimalSeparator": ",", "thousandSeparator": "." },
  "requiredOverrides": ["string"],
  "active": true,
  "archived": false,           // derived from archivedAt
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"      // NOT an optimistic-lock token
}
```

## Consumed (read-only) — not owned by this slice

- `GET /api/master-data/customers` → the customer selector (existing; query key
  `['master-data','customers']`).
- The Trip Import selector (`trip-import-client.tsx`) already filters `active && !archived` — the
  create→appears-in-selector e2e assertion exercises it.
