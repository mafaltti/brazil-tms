# Contracts: Predefined Import Template (slice 013)

This slice exposes **no new HTTP endpoint** and **changes no request/response shape**. The "contract"
surface is: (1) the in-code standard-format constant, (2) the relocated `inferFileType` helper, (3) the
unchanged BFF endpoints (documented so reviewers can confirm they are untouched), and (4) the i18n key
delta.

## 1. `STANDARD_IMPORT_TEMPLATE` (shared constant)

```ts
// packages/shared/src/import/standard-template.ts
import type { TemplateConfig } from "../schemas/import";

/**
 * The single, customer-agnostic standard import format (slice 013). Documented §29 provisional default —
 * the demo mapping (packages/db/seed/import-sample.ts) reused verbatim. Applied to every import when the
 * batch has no template. Metadata fields (customerId/name/version/fileType) are INERT: applyTemplate reads
 * only columnMappings + parsingRules, and the parser is chosen from the uploaded file's extension.
 */
export const STANDARD_IMPORT_TEMPLATE: TemplateConfig = {
  customerId: "00000000-0000-0000-0000-000000000000", // unused — format is customer-agnostic
  name: "Padrão Brazil Transports (provisório)",
  version: 1,
  fileType: "csv", // inert — parser chosen by inferFileType(fileName)
  columnMappings: [
    { source: "id_viagem", target: "externalTripId", required: true },
    { source: "origem", target: "originCode", required: true },
    { source: "destino", target: "destinationCode", required: true },
    { source: "janela_coleta_inicio", target: "plannedPickupWindowStart" },
    { source: "janela_coleta_fim", target: "plannedPickupWindowEnd" },
    { source: "janela_entrega_inicio", target: "plannedDeliveryWindowStart" },
    { source: "janela_entrega_fim", target: "plannedDeliveryWindowEnd" },
    { source: "tipo_veiculo", target: "plannedVehicleType" },
    { source: "status", target: "statusLabel" },
  ],
  parsingRules: {
    dateFormats: ["dd/MM/yyyy HH:mm"],
    timezone: "America/Sao_Paulo",
    decimalSeparator: ",",
    thousandSeparator: ".",
  },
  requiredOverrides: [],
};
```

**Contract guarantees** (assert in tests):
- `templateConfigSchema.parse(STANDARD_IMPORT_TEMPLATE)` succeeds.
- It is **one object** — editing it is the only change needed to swap in a real signed-off format (FR-010 / SC-007).
- `requiredOverrides` is `[]` (no new required-column enforcement, R8).

## 2. `inferFileType` (relocated shared helper)

```ts
// packages/shared/src/import/file-type.ts
/** Map a filename extension to the supported import file type, or null when unsupported. */
export function inferFileType(fileName: string): "csv" | "xlsx" | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".xlsx")) return "xlsx";
  return null;
}
```

- **Consumers**: `apps/web/app/api/imports/route.ts` (upload validation — replaces its local copy) and
  `workers/jobs/parse/index.ts` (parser choice). One canonical rule across upload + parse.
- **Worker usage**: `const fileType = inferFileType(batch.fileName)`. If `null` (shouldn't happen — the
  BFF already rejected unsupported types at upload), fail the batch with the existing
  unreadable-file message as defense-in-depth.

## 3. BFF endpoints — UNCHANGED (documented for review)

| Endpoint | Permission | Change |
|----------|-----------|--------|
| `POST /api/imports` | `import_trips` | **None.** Already accepts optional `templateId`; the client simply stops sending it. Returns `202 {id}`. |
| `GET /api/imports`, `GET /api/imports/{id}`, `…/rows`, `…/confirm`, `…/error-report`, `…/locations` | `import_trips` | **None.** |
| `GET/POST /api/import-templates`, `…/{id}` | `import_trips` | **None — dormant.** Retained for future per-customer configs; no client references them after this slice. |

`import.create` audit `newValue` stays `{ fileName, customerId }` (never recorded `templateId`) → no
audit-completeness impact.

## 4. i18n delta (`apps/web/messages/pt-BR.json`, `Imports` namespace)

| Key | Action | Value |
|-----|--------|-------|
| `Imports.provisionalNotice` | **ADD** (flat key) | e.g. `"Formato de importação padrão provisório — modelo de exemplo pendente de confirmação do cliente; pode mudar."` |
| `Imports.uploadSubtitle` | **REWRITE** | `"Selecione o cliente e o arquivo a enviar."` (drops "o modelo de importação") |
| `Imports.template` | **REMOVE** | (dead — control removed) |
| `Imports.selectTemplate` | **REMOVE** | (dead) |
| `Imports.noTemplates` | **REMOVE** | (dead) |

- All keys stay **flat** (no dots in the key path → no next-intl `INVALID_KEY`).
- `messages.test.ts` assertions: `Imports.provisionalNotice` exists; the three template keys are gone; no
  dotted keys; (existing) no missing/dangling references.

## 5. UI contract (`/imports` upload screen)

- Inputs visible to the operator: **Cliente** (Select) + **Arquivo** (file input). **No template control.**
- A persistent provisional banner renders at the top of the screen whenever it is displayed (US2 AC1).
- Submit enabled on `customer && file` (unchanged gate, minus any template consideration); on submit the
  form posts `file` + `customerId` only.
- Wrong-format file → existing per-row reasons in the preview (no header-level message); empty/header-only
  file → empty preview (R8).
