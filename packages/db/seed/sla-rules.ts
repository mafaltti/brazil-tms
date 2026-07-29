import "dotenv/config";
import { and, eq, isNull } from "drizzle-orm";
import { customers, customerSlaRules, db } from "../src";

/**
 * Feature 007 — example per-customer SLA rule seed (CUST-005). Seeds ONE customer-default rule for the
 * `db:seed:master-data` demo customer (DEMO-SHOPEE) so the evaluator uses it for that customer's
 * trips while every other customer falls back to `DEFAULT_SLA_POLICY` (and is reported SLA sign-off
 * blocked — FR-022). LABELED SCAFFOLDING (Constitution II): not final business sign-off. Idempotent:
 * keyed on the demo customer's existing customer-default rule. Run AFTER `db:migrate` +
 * `db:seed:master-data`:  pnpm --filter @brazil-tms/db db:seed:sla-rules
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

  // Idempotent: a customer-default rule (no lane, no vehicle type) already present → skip.
  const existing = await db
    .select({ id: customerSlaRules.id })
    .from(customerSlaRules)
    .where(
      and(
        eq(customerSlaRules.customerId, customerId),
        isNull(customerSlaRules.laneId),
        isNull(customerSlaRules.vehicleType),
      ),
    )
    .limit(1);
  if (existing[0]) {
    console.log(`SLA rule for ${DEMO_CODE} already present. Skipping.`);
    return;
  }

  await db.insert(customerSlaRules).values({
    customerId,
    pickupToleranceMinutes: 15,
    deliveryToleranceMinutes: 30,
    confirmationCutoffMinutes: 90,
    atRiskWarningMinutes: 60,
  });
  console.log(
    `Seeded example customer_sla_rules row for ${DEMO_CODE} (pickup 15 / delivery 30 / confirm 90 / warn 60 min).`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
