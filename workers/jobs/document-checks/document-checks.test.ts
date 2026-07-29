import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  alerts,
  billingItems,
  customers,
  db,
  documentRequirements,
  documents,
  documentTypes,
  locations,
  trips,
  users,
} from "@brazil-tms/db";
import { runDocumentChecks } from "./index";

/**
 * Feature 008 (US2, T070) — the document-checks sweep against the live dev DB. Static imports; skips
 * when DATABASE_URL is unset. Verifies the two §17 cases fire on their distinct predicates,
 * idempotency (ON CONFLICT — no duplicate), and auto-resolution on clear.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("documents.checks sweep (integration, US2)", () => {
  let actorId = "";
  let customerId = "";
  let originId = "";
  let destId = "";
  let typeId = "";
  const tripIds: string[] = [];

  function code(p: string): string {
    return `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  async function seedBillingTrip(opts: { base: number | null }): Promise<string> {
    const trip = (
      await db
        .insert(trips)
        .values({
          customerId,
          originLocationId: originId,
          destinationLocationId: destId,
          originalPlan: {},
          currentStatus: "billing_pending",
        })
        .returning({ id: trips.id })
    )[0]!.id;
    tripIds.push(trip);
    await db.insert(billingItems).values({
      tripId: trip,
      customerId,
      baseFreightCents: opts.base,
      billingPeriod: "2026-06",
    });
    return trip;
  }

  function openCasesFor(tripId: string, alertCase: string) {
    return db
      .select({ id: alerts.id, state: alerts.state })
      .from(alerts)
      .where(and(eq(alerts.tripId, tripId), eq(alerts.alertCase, alertCase)));
  }

  beforeAll(async () => {
    actorId = (
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, "admin@braziltransports.com.br"))
        .limit(1)
    )[0]!.id;

    customerId = (
      await db
        .insert(customers)
        .values({ name: "Cliente Sweep", customerCode: code("CUST") })
        .returning()
    )[0]!.id;
    originId = (
      await db.insert(locations).values({ customerId, code: code("O"), name: "Origem" }).returning()
    )[0]!.id;
    destId = (
      await db.insert(locations).values({ customerId, code: code("D"), name: "Destino" }).returning()
    )[0]!.id;
    typeId = (
      await db.insert(documentTypes).values({ code: code("dt"), labelPt: "POD" }).returning()
    )[0]!.id;
    await db.insert(documentRequirements).values({
      customerId,
      documentTypeId: typeId,
      requiredForCompletion: false,
      requiredForBilling: true,
    });
  });

  afterAll(async () => {
    for (const id of tripIds) {
      await db.delete(alerts).where(eq(alerts.tripId, id));
      await db.delete(documents).where(eq(documents.tripId, id));
      await db.delete(billingItems).where(eq(billingItems.tripId, id));
      await db.delete(trips).where(eq(trips.id, id));
    }
    await db.delete(documentRequirements).where(eq(documentRequirements.customerId, customerId));
    if (typeId) await db.delete(documentTypes).where(eq(documentTypes.id, typeId));
    for (const id of [originId, destId]) if (id) await db.delete(locations).where(eq(locations.id, id));
    if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
  });

  it("case 7 + case 8 fire for a priced billing-phase trip missing its required-for-billing proof", async () => {
    const tripId = await seedBillingTrip({ base: 150_000 }); // priced ⇒ the ONLY blocker is missing proof
    await runDocumentChecks();

    const c7 = await openCasesFor(tripId, "completed_missing_documents");
    const c8 = await openCasesFor(tripId, "billing_blocked_missing_proof");
    expect(c7.length).toBe(1);
    expect(c7[0]!.state).toBe("active");
    expect(c8.length).toBe(1);
    expect(c8[0]!.state).toBe("active");
  });

  it("re-running the sweep does not duplicate the alerts (idempotent)", async () => {
    const tripId = tripIds[tripIds.length - 1]!;
    await runDocumentChecks();
    const c7 = await openCasesFor(tripId, "completed_missing_documents");
    const active7 = c7.filter((a) => a.state === "active");
    expect(active7.length).toBe(1);
  });

  it("accepting the required document auto-resolves both cases", async () => {
    const tripId = tripIds[tripIds.length - 1]!;
    await db.insert(documents).values({
      tripId,
      documentTypeId: typeId,
      fileStorageKey: `trips/${tripId}/pod.pdf`,
      uploadedByUserId: actorId,
      verificationStatus: "accepted",
    });
    await runDocumentChecks();

    const c7 = await openCasesFor(tripId, "completed_missing_documents");
    const c8 = await openCasesFor(tripId, "billing_blocked_missing_proof");
    expect(c7.every((a) => a.state === "resolved")).toBe(true);
    expect(c8.every((a) => a.state === "resolved")).toBe(true);
  });

  it("case 8 does NOT fire when blocked ONLY by no_pricing (billing docs satisfied, base null)", async () => {
    const tripId = await seedBillingTrip({ base: null }); // unpriced
    // satisfy the required-for-billing doc so the only billing blocker is no_pricing.
    await db.insert(documents).values({
      tripId,
      documentTypeId: typeId,
      fileStorageKey: `trips/${tripId}/pod.pdf`,
      uploadedByUserId: actorId,
      verificationStatus: "accepted",
    });
    await runDocumentChecks();

    const c8 = await openCasesFor(tripId, "billing_blocked_missing_proof");
    const active8 = c8.filter((a) => a.state === "active");
    expect(active8.length).toBe(0); // no_pricing ≠ missing proof → case 8 must NOT fire
    const c7 = await openCasesFor(tripId, "completed_missing_documents");
    expect(c7.filter((a) => a.state === "active").length).toBe(0); // docs satisfied → case 7 clear
    expect(inArray).toBeDefined();
  });
});
