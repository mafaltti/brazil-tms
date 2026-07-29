import "dotenv/config";
import { eq } from "drizzle-orm";
import { carriers, customers, db, lanes, locations, vehicles } from "../src";

/**
 * Optional demo seed for feature 002 (master data). Provisions a small, coherent dataset to
 * exercise the Administration + Resource Management screens: one customer, two of its locations, a
 * lane between them, one owned vehicle, and one subcontracted vehicle linked to a carrier. Run AFTER
 * `db:migrate`:  pnpm --filter @brazil-tms/db db:seed:master-data
 * Idempotent: keyed on the demo customer code — re-running is a no-op once seeded.
 */
const DEMO_CODE = "DEMO-SHOPEE";

async function main(): Promise<void> {
  const existing = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.customerCode, DEMO_CODE))
    .limit(1);
  if (existing[0]) {
    console.log(`Demo master-data already present (customer ${DEMO_CODE}). Skipping.`);
    return;
  }

  const [customer] = await db
    .insert(customers)
    .values({
      name: "Shopee (Demo)",
      legalName: "Shopee Brasil Demo Ltda.",
      customerCode: DEMO_CODE,
      taxId: "12345678000195",
      contacts: [{ name: "Ana Souza", email: "ana@demo.com", role: "Operações" }],
      billingContact: { name: "Financeiro Demo", email: "fin@demo.com" },
    })
    .returning();

  const [origin, destination] = await db
    .insert(locations)
    .values([
      { customerId: customer!.id, code: "CD-SP", name: "CD São Paulo", city: "São Paulo", state: "SP" },
      { customerId: customer!.id, code: "CD-RJ", name: "CD Rio de Janeiro", city: "Rio de Janeiro", state: "RJ" },
    ])
    .returning();

  await db.insert(lanes).values({
    customerId: customer!.id,
    originLocationId: origin!.id,
    destinationLocationId: destination!.id,
    expectedTransitMinutes: 360,
    defaultVehicleType: "truck",
    standardRateCents: 250000,
    tollEstimateCents: 18000,
    standardDistanceKm: "430",
  });

  const [carrier] = await db
    .insert(carriers)
    .values({
      name: "Transportes Parceiros (Demo)",
      taxId: "98765432000110",
      contractStatus: "active",
      documentationStatus: "complete",
    })
    .returning();

  await db.insert(vehicles).values([
    { plate: "ABC1D23", vehicleType: "truck", ownershipType: "owned", owner: "Frota Própria", capacityKg: 12000 },
    {
      plate: "XYZ4E56",
      vehicleType: "carreta",
      ownershipType: "subcontracted",
      carrierId: carrier!.id,
      capacityKg: 27000,
    },
  ]);

  console.log(`Seeded demo master data: customer ${DEMO_CODE}, 2 locations, 1 lane, 1 carrier, 2 vehicles.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
