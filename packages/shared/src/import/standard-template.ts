import type { TemplateConfig } from "../schemas/import";

/**
 * The single, customer-agnostic standard import format (slice 013). Documented §29 provisional default —
 * the demo mapping (packages/db/seed/import-sample.ts) reused verbatim. Applied to every import when the
 * batch has no template (`import_batches.template_id` is null). Metadata fields
 * (customerId/name/version/fileType) are INERT: `applyTemplate` reads only `columnMappings` +
 * `parsingRules`, and the parser is chosen from the uploaded file's extension (`inferFileType`), so
 * `fileType` is ignored and `customerId` is a fixed nil UUID.
 *
 * Swapping in a real signed-off customer format is a single-object edit (FR-010 / SC-007). The shape is
 * asserted against `templateConfigSchema` in `standard-template.test.ts`, so a malformed edit fails fast.
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
