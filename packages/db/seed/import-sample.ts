import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { customers, db, importTemplates, statusMappings } from "../src";

/**
 * Optional demo seed for feature 004 (trip import). Provisions LABELED SCAFFOLDING (Constitution II):
 * a default per-customer import template + a handful of status-label mappings for the 002 demo
 * customer, so the Trip Import screen has something to select. Run AFTER `db:seed:master-data`:
 *   pnpm --filter @brazil-tms/db db:seed:import
 * Idempotent: keyed on the template name.
 *
 * BLOCKED business inputs (PRD §29 — these are documented DEFAULTS, not final values):
 *  - column mappings + parsing rules below mirror a plausible Shopee-style CSV, NOT a signed-off file;
 *  - status-label vocabulary (Novo/Criada/Planejada/Pendente → received) is a placeholder set;
 *  - required-field overrides are empty (none forced beyond the engine defaults);
 *  - the fuzzy-duplicate tolerance is the day-bucket default in `@brazil-tms/shared` `buildFuzzyKey`.
 * Sample fixtures live in `packages/db/seed/fixtures/import-clean.csv` and `import-errors.csv`.
 */
const DEMO_CODE = "DEMO-SHOPEE";
const TEMPLATE_NAME = "Padrão Shopee (scaffolding)";

async function main(): Promise<void> {
  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.customerCode, DEMO_CODE))
    .limit(1);
  if (!customer) {
    console.error(`Customer ${DEMO_CODE} not found — run \`db:seed:master-data\` first.`);
    process.exit(1);
  }

  const existing = await db
    .select({ id: importTemplates.id })
    .from(importTemplates)
    .where(and(eq(importTemplates.customerId, customer.id), eq(importTemplates.name, TEMPLATE_NAME)))
    .limit(1);
  if (existing[0]) {
    console.log("Import scaffolding already present. Skipping.");
    return;
  }

  await db.insert(importTemplates).values({
    customerId: customer.id,
    name: TEMPLATE_NAME,
    version: 1,
    fileType: "csv",
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
  });

  // Status-label mappings (documented default — import records/validates only; trips land in `received`).
  for (const customerLabel of ["Novo", "Criada", "Planejada", "Pendente"]) {
    await db
      .insert(statusMappings)
      .values({ customerId: customer.id, customerLabel, internalStatus: "received" })
      .onConflictDoNothing();
  }

  console.log(
    `Seeded import scaffolding for ${DEMO_CODE}: 1 template + 4 status mappings (documented defaults — BLOCKED on real files).`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
