import "dotenv/config";
import { and, eq } from "drizzle-orm";
import {
  assignTrip,
  cancellationOptions,
  customers,
  db,
  drivers,
  locations,
  transitionTripStatus,
  trips,
  users,
  vehicles,
} from "../src";

/**
 * Feature 003 trip-domain seed. Seeds the `cancellation_options` `billing_impact` value set as
 * LABELED SCAFFOLDING (Constitution II — §19.5 examples) and intentionally leaves the `reason` codes
 * EMPTY: those are business-blocked, so a production cancellation fails with
 * `CANCELLATION_NOT_CONFIGURED` until business supplies the codes (tests/e2e seed their own).
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

const SAMPLE_EXTERNAL_TRIP_ID = "DEMO-TRIP-001";
const ADMIN_EMAIL = "admin@braziltransports.com.br";
const DEMO_DRIVER_NAME = "Motorista Demo (trip-domain)";
const DEMO_PLATE = "DMO0001";

/** A future yyyy-mm-dd so seeded resource documents are valid (not expired/expiring). */
function farFutureDate(): string {
  return new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function seedCancellationOptions(): Promise<void> {
  for (const b of BILLING_IMPACTS) {
    const existing = await db
      .select({ id: cancellationOptions.id })
      .from(cancellationOptions)
      .where(
        and(eq(cancellationOptions.kind, "billing_impact"), eq(cancellationOptions.code, b.code)),
      )
      .limit(1);
    if (existing[0]) continue;
    await db.insert(cancellationOptions).values({
      kind: "billing_impact",
      code: b.code,
      labelPt: b.labelPt,
      sortOrder: b.sortOrder,
    });
  }
  // `reason` codes are intentionally NOT seeded (business-blocked). Do not add them here.
  console.log(
    "Seeded cancellation_options billing_impact scaffolding (no_charge, cancellation_fee, manual_review); reason codes left EMPTY (business-blocked).",
  );
}

/**
 * Seeds up to three demo trips on DEMO-SHOPEE so the operating surfaces have data ACROSS statuses:
 * DEMO-TRIP-001 stays `received` (the subject of the 010 Validate action), DEMO-TRIP-002 is advanced to
 * `validated` (so the Dispatch Board's `status=validated` queue is non-empty), and DEMO-TRIP-003 is
 * advanced to `assigned`. The advances go THROUGH the services (`transitionTripStatus` / `assignTrip`),
 * NEVER a raw status `UPDATE` (Constitution III / data-model INV-1) — so they write the append-only
 * `trip_events` + `audit_logs`. DEMO only: the e2e specs self-seed their own trips (this is
 * `db:seed:trip-domain`, not `db:seed:e2e`). Idempotent: re-running advances only what is still behind.
 */
async function seedSampleTrip(): Promise<void> {
  const demo = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.customerCode, "DEMO-SHOPEE"))
    .limit(1);
  if (!demo[0]) {
    console.log("DEMO-SHOPEE master data absent; skipping sample trips (run db:seed:master-data first).");
    return;
  }
  const customerId = demo[0].id;

  const locs = await db
    .select({ id: locations.id })
    .from(locations)
    .where(eq(locations.customerId, customerId))
    .limit(2);
  if (locs.length < 2) {
    console.log("Need >=2 demo locations to anchor a trip; skipping sample trips.");
    return;
  }
  const [origin, dest] = locs;
  const originalPlan = {
    customerId,
    originLocationId: origin!.id,
    destinationLocationId: dest!.id,
    plannedVehicleType: "truck",
  };

  // Insert a fresh `received` trip if its external id is absent; returns its id + current status.
  async function ensureTrip(externalTripId: string): Promise<{ id: string; status: string }> {
    const existing = await db
      .select({ id: trips.id, status: trips.currentStatus })
      .from(trips)
      .where(and(eq(trips.customerId, customerId), eq(trips.externalTripId, externalTripId)))
      .limit(1);
    if (existing[0]) return { id: existing[0].id, status: existing[0].status };
    const inserted = await db
      .insert(trips)
      .values({
        customerId,
        externalTripId,
        originLocationId: origin!.id,
        destinationLocationId: dest!.id,
        currentStatus: "received",
        originalPlan,
        plannedVehicleType: "truck",
      })
      .returning({ id: trips.id });
    return { id: inserted[0]!.id, status: "received" };
  }

  // DEMO-TRIP-001 — stays `received` (the Validate action's subject).
  await ensureTrip(SAMPLE_EXTERNAL_TRIP_ID);

  // The transition/assignment services need an actor; without the seeded admin we can only seed `received`.
  const adminRow = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, ADMIN_EMAIL))
    .limit(1);
  const actorId = adminRow[0]?.id;
  if (!actorId) {
    console.log(
      `Seeded ${SAMPLE_EXTERNAL_TRIP_ID} (received). Admin actor absent (run db:seed) — skipping the validated/assigned demo trips.`,
    );
    return;
  }

  // DEMO-TRIP-002 — received -> validated VIA the service (shows in the dispatch queue).
  const t2 = await ensureTrip("DEMO-TRIP-002");
  if (t2.status === "received") {
    await transitionTripStatus(
      t2.id,
      { expectedFromStatus: "received", toStatus: "validated", source: "operator_manual" },
      actorId,
    );
  }

  // DEMO-TRIP-003 — received -> validated -> assigned (needs a clean owned driver + vehicle).
  const t3 = await ensureTrip("DEMO-TRIP-003");
  if (t3.status === "received") {
    await transitionTripStatus(
      t3.id,
      { expectedFromStatus: "received", toStatus: "validated", source: "operator_manual" },
      actorId,
    );
  }
  if (t3.status === "received" || t3.status === "validated") {
    const driverId = await ensureDemoDriver();
    const vehicleId = await ensureDemoVehicle();
    await assignTrip(
      t3.id,
      { driverId, vehicleId, expectedFromStatus: "validated", notes: "Atribuição demo (trip-domain seed)" },
      actorId,
    );
  }

  console.log(
    `Seeded demo trips on DEMO-SHOPEE: ${SAMPLE_EXTERNAL_TRIP_ID} (received), DEMO-TRIP-002 (validated), DEMO-TRIP-003 (assigned).`,
  );
}

/**
 * A clean OWNED, active demo driver with valid documents (idempotent by name). REPAIRS the clean state
 * (active, un-archived, future license) on re-run so an edited or aged-out demo row cannot block the
 * DEMO-TRIP-003 assignment via the eligibility evaluator (PR #13 review).
 */
async function ensureDemoDriver(): Promise<string> {
  const clean = { status: "active" as const, licenseExpiry: farFutureDate(), archivedAt: null };
  const existing = await db
    .select({ id: drivers.id })
    .from(drivers)
    .where(eq(drivers.name, DEMO_DRIVER_NAME))
    .limit(1);
  if (existing[0]) {
    await db.update(drivers).set(clean).where(eq(drivers.id, existing[0].id));
    return existing[0].id;
  }
  const inserted = await db
    .insert(drivers)
    .values({ name: DEMO_DRIVER_NAME, ownershipType: "owned", ...clean })
    .returning({ id: drivers.id });
  return inserted[0]!.id;
}

/**
 * A clean OWNED, active demo truck with valid documents (idempotent by plate). REPAIRS the clean state
 * (active, un-archived, future document expiry) on re-run for the same reason as {@link ensureDemoDriver}.
 */
async function ensureDemoVehicle(): Promise<string> {
  const clean = { status: "active" as const, documentExpiry: farFutureDate(), archivedAt: null };
  const existing = await db
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(eq(vehicles.plate, DEMO_PLATE))
    .limit(1);
  if (existing[0]) {
    await db.update(vehicles).set(clean).where(eq(vehicles.id, existing[0].id));
    return existing[0].id;
  }
  const inserted = await db
    .insert(vehicles)
    .values({ plate: DEMO_PLATE, vehicleType: "truck", ownershipType: "owned", ...clean })
    .returning({ id: vehicles.id });
  return inserted[0]!.id;
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
