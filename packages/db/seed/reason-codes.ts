import "dotenv/config";
import { eq } from "drizzle-orm";
import { db, reasonCodes } from "../src";

/**
 * Feature 007 — exception reason-code seed (EXC-004). LABELED SCAFFOLDING (Constitution II): one
 * sensible default row per EXC-004 category with a default severity + responsible party, so the
 * exception flow is demonstrable end-to-end at MVP. This is explicitly NOT final business sign-off
 * (mirrors 003's `cancellation_options` gap — but unlike it, 007 seeds rows so the queue works).
 * Idempotent: keyed on `code`. Run AFTER `db:migrate`:
 *   pnpm --filter @brazil-tms/db db:seed:reason-codes
 */

const ROWS = [
  { code: "DELAY", category: "delay", labelPt: "Atraso geral", severity: "medium", party: "unknown", sort: 1 },
  { code: "NO_SHOW", category: "no_show", labelPt: "Não comparecimento", severity: "high", party: "carrier_caused", sort: 2 },
  { code: "BREAKDOWN", category: "breakdown", labelPt: "Pane mecânica", severity: "high", party: "carrier_caused", sort: 3 },
  { code: "DRIVER_ISSUE", category: "driver_issue", labelPt: "Problema com motorista", severity: "medium", party: "carrier_caused", sort: 4 },
  { code: "CUSTOMER_DELAY", category: "customer_delay", labelPt: "Atraso do cliente", severity: "medium", party: "customer_caused", sort: 5 },
  { code: "LOADING_DELAY", category: "loading_delay", labelPt: "Atraso no carregamento", severity: "medium", party: "customer_caused", sort: 6 },
  { code: "UNLOADING_DELAY", category: "unloading_delay", labelPt: "Atraso no descarregamento", severity: "medium", party: "customer_caused", sort: 7 },
  { code: "DOCUMENTATION", category: "documentation", labelPt: "Documentação", severity: "low", party: "brazil_transports_caused", sort: 8 },
  { code: "ACCIDENT", category: "accident", labelPt: "Acidente", severity: "high", party: "force_majeure", sort: 9 },
  { code: "ROUTE_DEVIATION", category: "route_deviation", labelPt: "Desvio de rota", severity: "low", party: "carrier_caused", sort: 10 },
  { code: "CANCELLATION", category: "cancellation", labelPt: "Cancelamento", severity: "high", party: "customer_caused", sort: 11 },
  { code: "OTHER", category: "other", labelPt: "Outro", severity: "low", party: "unknown", sort: 12 },
] as const;

async function main(): Promise<void> {
  let inserted = 0;
  for (const r of ROWS) {
    const existing = await db
      .select({ id: reasonCodes.id })
      .from(reasonCodes)
      .where(eq(reasonCodes.code, r.code))
      .limit(1);
    if (existing[0]) continue;
    await db.insert(reasonCodes).values({
      code: r.code,
      category: r.category,
      labelPt: r.labelPt,
      defaultSeverity: r.severity,
      defaultResponsibleParty: r.party,
      sortOrder: r.sort,
    });
    inserted += 1;
  }
  console.log(
    `Seeded reason_codes scaffolding: ${inserted} new of ${ROWS.length} categories (labeled defaults — NOT final business sign-off).`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
