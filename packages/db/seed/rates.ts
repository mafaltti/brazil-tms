import "dotenv/config";
import { and, eq, isNull } from "drizzle-orm";
import { customers, db, rates } from "../src";

/**
 * Feature 008 — example rate seed (BILL-002). Seeds ONE customer-default rate for the
 * `db:seed:master-data` demo customer (DEMO-SHOPEE) so a completed trip for that customer auto-prices
 * and Billing Ready is demonstrable; every other customer (no matching rate) uses a manual amount + is
 * reported billing-rule sign-off blocked (§29 Input #5). LABELED SCAFFOLDING (Constitution II).
 * Idempotent: keyed on the demo customer's existing customer-default rate. Run AFTER db:migrate +
 * db:seed:master-data:  pnpm --filter @brazil-tms/db db:seed:rates
 */
const DEMO_CODE = "DEMO-SHOPEE";

async function main(): Promise<void> {
  const demo = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.customerCode, DEMO_CODE))
    .limit(1);
  if (!demo[0]) {
    console.log(`${DEMO_CODE} master data absent; skipping (run db:seed:master-data first).`);
    return;
  }
  const customerId = demo[0].id;

  // Idempotent: a customer-default rate (no lane, no vehicle type) already present → skip.
  const existing = await db
    .select({ id: rates.id })
    .from(rates)
    .where(and(eq(rates.customerId, customerId), isNull(rates.laneId), isNull(rates.vehicleType)))
    .limit(1);
  if (existing[0]) {
    console.log(`Rate for ${DEMO_CODE} already present. Skipping.`);
    return;
  }

  await db.insert(rates).values({
    customerId,
    baseAmountCents: 150_000, // R$ 1.500,00 customer-default base freight (labeled scaffolding)
  });
  console.log(`Seeded example rates row for ${DEMO_CODE} (base R$ 1.500,00 customer-default).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
