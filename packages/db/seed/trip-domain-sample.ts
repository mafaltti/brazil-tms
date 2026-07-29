import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { cancellationOptions, customers, db, locations, trips } from "../src";

/**
 * Feature 003 trip-domain seed. Seeds BOTH `cancellation_options` value sets as LABELED SCAFFOLDING
 * (Constitution II): the `billing_impact` §19.5 examples (003) and — since slice 017 (clarification
 * 2026-07-27, spec FR-013) — a default pt-BR `reason` set so the cancel flow works out of the box.
 * Business sign-off on the final lists remains pending; both stay config (admins may edit rows).
 *
 * Optionally anchors 1 sample trip on the `db:seed:master-data` demo customer (DEMO-SHOPEE) so the
 * read-only inspector has something to show. Idempotent: re-running is a no-op once seeded. Run AFTER
 * `db:migrate`:  pnpm --filter @brazil-tms/db db:seed:trip-domain
 */

// §19.5 examples — billing-impact scaffolding (labeled; NOT final business sign-off).
const BILLING_IMPACTS = [
  { code: "no_charge", labelPt: "Sem cobrança", sortOrder: 1 },
  { code: "cancellation_fee", labelPt: "Taxa de cancelamento", sortOrder: 2 },
  { code: "manual_review", labelPt: "Revisão manual", sortOrder: 3 },
] as const;

// 017 defaults (FR-013) — reason scaffolding (labeled; NOT final business sign-off).
const CANCELLATION_REASONS = [
  { code: "cancelled_by_customer", labelPt: "Cancelado pelo cliente", sortOrder: 1 },
  { code: "no_vehicle_available", labelPt: "Sem veículo disponível", sortOrder: 2 },
  { code: "no_driver_available", labelPt: "Sem motorista disponível", sortOrder: 3 },
  { code: "weather_road", labelPt: "Clima/estrada", sortOrder: 4 },
  { code: "documentation_issue", labelPt: "Problema de documentação", sortOrder: 5 },
  { code: "other", labelPt: "Outro", sortOrder: 6 },
] as const;

const SAMPLE_EXTERNAL_TRIP_ID = "DEMO-TRIP-001";

async function seedCancellationOptions(): Promise<void> {
  const sets = [
    { kind: "billing_impact", rows: BILLING_IMPACTS },
    { kind: "reason", rows: CANCELLATION_REASONS },
  ] as const;
  for (const { kind, rows } of sets) {
    for (const r of rows) {
      const existing = await db
        .select({ id: cancellationOptions.id })
        .from(cancellationOptions)
        .where(and(eq(cancellationOptions.kind, kind), eq(cancellationOptions.code, r.code)))
        .limit(1);
      if (existing[0]) continue;
      await db.insert(cancellationOptions).values({
        kind,
        code: r.code,
        labelPt: r.labelPt,
        sortOrder: r.sortOrder,
      });
    }
  }
  console.log(
    "Seeded cancellation_options scaffolding: billing_impact (no_charge, cancellation_fee, manual_review) + reason (017 defaults — business sign-off pending).",
  );
}

async function seedSampleTrip(): Promise<void> {
  const demo = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.customerCode, "DEMO-SHOPEE"))
    .limit(1);
  if (!demo[0]) {
    console.log("DEMO-SHOPEE master data absent; skipping sample trip (run db:seed:master-data first).");
    return;
  }
  const customerId = demo[0].id;

  const locs = await db
    .select({ id: locations.id })
    .from(locations)
    .where(eq(locations.customerId, customerId))
    .limit(2);
  if (locs.length < 2) {
    console.log("Need >=2 demo locations to anchor a trip; skipping sample trip.");
    return;
  }

  const existing = await db
    .select({ id: trips.id })
    .from(trips)
    .where(and(eq(trips.customerId, customerId), eq(trips.externalTripId, SAMPLE_EXTERNAL_TRIP_ID)))
    .limit(1);
  if (existing[0]) {
    console.log(`Sample trip ${SAMPLE_EXTERNAL_TRIP_ID} already present. Skipping.`);
    return;
  }

  const [origin, dest] = locs;
  const originalPlan = {
    customerId,
    originLocationId: origin!.id,
    destinationLocationId: dest!.id,
    plannedVehicleType: "truck",
  };
  await db.insert(trips).values({
    customerId,
    externalTripId: SAMPLE_EXTERNAL_TRIP_ID,
    originLocationId: origin!.id,
    destinationLocationId: dest!.id,
    currentStatus: "received",
    originalPlan,
    plannedVehicleType: "truck",
  });
  console.log(`Seeded sample trip ${SAMPLE_EXTERNAL_TRIP_ID} (status received) on DEMO-SHOPEE master data.`);
}

async function main(): Promise<void> {
  await seedCancellationOptions();
  await seedSampleTrip();
  console.log("Trip-domain seed complete.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
