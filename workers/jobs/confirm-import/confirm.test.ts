import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  assignTrip,
  auditLogs,
  customers,
  alerts,
  db,
  drivers,
  importBatches,
  importRows,
  importTemplates,
  locations,
  tripAssignments,
  tripEvents,
  trips,
  users,
  vehicles,
} from "@brazil-tms/db";
import { originalStorageKey, putOriginal } from "@brazil-tms/db/storage";
import { runParse } from "../parse";
import { runValidate } from "../validate";
import { runDetectDuplicates } from "../detect-duplicates";
import { runConfirm } from "./index";

/**
 * T039 — confirm job integration test: drive the full US1 pipeline (parse → validate →
 * detect-duplicates → confirm) against the live dev DB + Storage, asserting trips are created
 * **born `received`** (slice 015) and linked to the batch, the confirm is idempotent (a re-run creates
 * 0 new trips), and the batch counts are tallied. Slice 015 also asserts: a confirm-created trip assigns
 * immediately (`received → assigned`, no ILLEGAL_TRANSITION), and an `update` to an already-`assigned`
 * trip keeps its status (FR-002, never downgraded). Static imports per project convention; skips without
 * DATABASE_URL.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("confirm job — full pipeline (integration)", () => {
  let actorId = "";
  let customerId = "";
  let templateId = "";
  // Owned active driver + matching `truck` vehicle (far-future docs) so a confirm-created trip can be
  // assigned in-test to prove `received → assigned` works (slice 015, US1).
  let driverId = "";
  let vehicleId = "";
  const createdBatchIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdTripIds: string[] = [];

  function uniq(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  beforeAll(async () => {
    const admin = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "admin@braziltransports.com.br"))
      .limit(1);
    actorId = admin[0]?.id ?? "";
    expect(actorId, "seeded admin must exist (run db:seed)").not.toBe("");

    const customer = await db
      .insert(customers)
      .values({ name: "Cliente Import Confirm", customerCode: uniq("CUST-CONFIRM") })
      .returning();
    customerId = customer[0]!.id;
    createdCustomerIds.push(customerId);

    await db.insert(locations).values([
      { customerId, code: "ORIG", name: "Origem", country: "BR" },
      { customerId, code: "DEST", name: "Destino", country: "BR" },
    ]);

    const template = await db
      .insert(importTemplates)
      .values({
        customerId,
        name: uniq("Template Confirm"),
        version: 1,
        fileType: "csv",
        columnMappings: [
          { source: "trip_id", target: "externalTripId" },
          { source: "origin", target: "originCode" },
          { source: "destination", target: "destinationCode" },
          { source: "pickup_start", target: "plannedPickupWindowStart" },
          { source: "vehicle", target: "plannedVehicleType" },
        ],
        parsingRules: {
          dateFormats: ["yyyy-MM-dd HH:mm"],
          timezone: "America/Sao_Paulo",
          decimalSeparator: ",",
          thousandSeparator: ".",
        },
        requiredOverrides: [],
      })
      .returning();
    templateId = template[0]!.id;

    // Resources for the in-test assignment (owned ⇒ no carrier required; far-future expiries ⇒ no
    // documentation finding; `truck` matches the CSV `Truck` vehicle so no type-mismatch BLOCK).
    const driver = await db
      .insert(drivers)
      .values({
        name: uniq("Motorista Confirm"),
        ownershipType: "owned",
        status: "active",
        licenseExpiry: "2030-01-01",
      })
      .returning();
    driverId = driver[0]!.id;

    const vehicle = await db
      .insert(vehicles)
      .values({
        plate: uniq("PLT").slice(0, 12),
        vehicleType: "truck",
        ownershipType: "owned",
        status: "active",
        documentExpiry: "2030-01-01",
      })
      .returning();
    vehicleId = vehicle[0]!.id;
  });

  afterAll(async () => {
    // FK-safe order for the trips ⇄ import_batches cycle: import_rows reference trips
    // (target_trip_id) AND trips reference import_batches (import_batch_id). So: drop ALL import_rows
    // first → then the trips → then the import_batches → then per-customer config.
    for (const batchId of createdBatchIds) {
      await db.delete(importRows).where(eq(importRows.importBatchId, batchId));
    }
    for (const tripId of createdTripIds) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, tripId));
    }
    if (createdTripIds.length > 0) {
      // FK-safe: drop assignment + event children before the trips they reference.
      await db.delete(tripAssignments).where(inArray(tripAssignments.tripId, createdTripIds));
      await db.delete(tripEvents).where(inArray(tripEvents.tripId, createdTripIds));
      await db.delete(alerts).where(inArray(alerts.tripId, createdTripIds));
      await db.delete(trips).where(inArray(trips.id, createdTripIds));
    }
    if (driverId) await db.delete(drivers).where(eq(drivers.id, driverId));
    if (vehicleId) await db.delete(vehicles).where(eq(vehicles.id, vehicleId));
    for (const batchId of createdBatchIds) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, batchId));
      await db.delete(importBatches).where(eq(importBatches.id, batchId));
    }
    for (const cid of createdCustomerIds) {
      await db.delete(importTemplates).where(eq(importTemplates.customerId, cid));
      await db.delete(locations).where(eq(locations.customerId, cid));
      await db.delete(auditLogs).where(eq(auditLogs.entityId, cid));
      await db.delete(customers).where(eq(customers.id, cid));
    }
  });

  async function seedBatchWithCsv(csv: string): Promise<string> {
    const batch = await db
      .insert(importBatches)
      .values({
        customerId,
        templateId,
        fileName: "trips.csv",
        storageKey: "pending",
        uploadedBy: actorId,
      })
      .returning();
    const batchId = batch[0]!.id;
    createdBatchIds.push(batchId);
    const key = originalStorageKey(batchId);
    await db.update(importBatches).set({ storageKey: key }).where(eq(importBatches.id, batchId));
    await putOriginal(batchId, Buffer.from(csv, "utf-8"), "text/csv");
    return batchId;
  }

  it("creates trips born received linked to the batch; re-running confirm is idempotent", async () => {
    const extA = uniq("SH-A");
    const extB = uniq("SH-B");
    const csv = [
      "trip_id,origin,destination,pickup_start,vehicle",
      `${extA},ORIG,DEST,2026-06-01 08:00,Truck`,
      `${extB},ORIG,DEST,2026-06-02 09:30,Carreta`,
    ].join("\n");

    const batchId = await seedBatchWithCsv(csv);

    await runParse({ batchId, storageKey: originalStorageKey(batchId) });
    await runValidate({ batchId });
    await runDetectDuplicates({ batchId });

    // After detect-duplicates: both rows are 'new', status 'validated'.
    const afterDetect = await db
      .select({ status: importBatches.status, createdCount: importBatches.createdCount })
      .from(importBatches)
      .where(eq(importBatches.id, batchId))
      .limit(1);
    expect(afterDetect[0]!.status).toBe("validated");
    expect(afterDetect[0]!.createdCount).toBe(2);

    await runConfirm({ batchId, actorUserId: actorId });

    const created = await db
      .select()
      .from(trips)
      .where(eq(trips.importBatchId, batchId));
    for (const t of created) createdTripIds.push(t.id);

    expect(created).toHaveLength(2);
    for (const t of created) {
      // Born received (slice 015, FR-001/FR-004) — `received` is the first dispatchable status.
      expect(t.currentStatus).toBe("received");
      expect(t.importBatchId).toBe(batchId);
      expect(t.customerId).toBe(customerId);
    }
    const externalIds = created.map((t) => t.externalTripId).sort();
    expect(externalIds).toEqual([extA, extB].sort());

    // Rows are linked + applied.
    const rows = await db
      .select()
      .from(importRows)
      .where(eq(importRows.importBatchId, batchId));
    for (const r of rows) {
      expect(r.appliedAt).not.toBeNull();
      expect(r.targetTripId).not.toBeNull();
    }

    const batchAfter = await db
      .select({
        status: importBatches.status,
        createdCount: importBatches.createdCount,
        updatedCount: importBatches.updatedCount,
      })
      .from(importBatches)
      .where(eq(importBatches.id, batchId))
      .limit(1);
    expect(batchAfter[0]!.status).toBe("completed");
    expect(batchAfter[0]!.createdCount).toBe(2);
    expect(batchAfter[0]!.updatedCount).toBe(0);

    // The import.confirm audit row is written at the batch level.
    const confirmAudit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, batchId), eq(auditLogs.action, "import.confirm")));
    expect(confirmAudit.length).toBeGreaterThanOrEqual(1);

    // RE-RUN confirm → idempotent: no NEW trips created.
    const tripCountBefore = (
      await db.select({ id: trips.id }).from(trips).where(eq(trips.importBatchId, batchId))
    ).length;

    await runConfirm({ batchId, actorUserId: actorId });

    const tripCountAfter = (
      await db.select({ id: trips.id }).from(trips).where(eq(trips.importBatchId, batchId))
    ).length;
    expect(tripCountAfter).toBe(tripCountBefore);
    expect(tripCountAfter).toBe(2);
  });

  it("a transient apply failure keeps the row retryable and holds the batch at 'validated'; re-confirm applies it", async () => {
    // A dedicated destination with a KNOWN id so we can drop it (forcing a confirm-time FK failure on
    // createTrip — a non-REVIEW_REQUIRED, non-unique error → APPLY_FAILED) and later restore it with the
    // SAME id to prove the still-pending row is RE-TRIED and applied on a second confirm.
    const destId = crypto.randomUUID();
    await db
      .insert(locations)
      .values({ id: destId, customerId, code: "DEST-RETRY", name: "Destino Retry", country: "BR" });

    const ext = uniq("SH-RETRY");
    const csv = [
      "trip_id,origin,destination,pickup_start,vehicle",
      `${ext},ORIG,DEST-RETRY,2026-06-01 08:00,Truck`,
    ].join("\n");
    const batchId = await seedBatchWithCsv(csv);
    await runParse({ batchId, storageKey: originalStorageKey(batchId) });
    await runValidate({ batchId }); // resolves DEST-RETRY → destId into mapped
    await runDetectDuplicates({ batchId }); // status validated, match new

    // Break the resolved location between validate and confirm → createTrip fails its FK.
    await db.delete(locations).where(eq(locations.id, destId));
    await runConfirm({ batchId, actorUserId: actorId });

    // The row is NOT terminally errored (still retryable), is unapplied, and the batch is HELD at
    // 'validated' so the operator can re-confirm — not silently 'completed'.
    const rowAfter1 = (
      await db.select().from(importRows).where(eq(importRows.importBatchId, batchId))
    )[0]!;
    expect(rowAfter1.outcome).not.toBe("error");
    expect(rowAfter1.appliedAt).toBeNull();
    expect(rowAfter1.targetTripId).toBeNull();
    const batch1 = (
      await db
        .select({ status: importBatches.status })
        .from(importBatches)
        .where(eq(importBatches.id, batchId))
        .limit(1)
    )[0]!;
    expect(batch1.status).toBe("validated");

    // Restore the location (same id) and re-confirm → the still-pending row now applies.
    await db
      .insert(locations)
      .values({ id: destId, customerId, code: "DEST-RETRY", name: "Destino Retry", country: "BR" });
    await runConfirm({ batchId, actorUserId: actorId });

    const created = await db.select().from(trips).where(eq(trips.importBatchId, batchId));
    for (const t of created) createdTripIds.push(t.id);
    expect(created).toHaveLength(1);
    const rowAfter2 = (
      await db.select().from(importRows).where(eq(importRows.importBatchId, batchId))
    )[0]!;
    expect(rowAfter2.appliedAt).not.toBeNull();
    const batch2 = (
      await db
        .select({ status: importBatches.status })
        .from(importBatches)
        .where(eq(importBatches.id, batchId))
        .limit(1)
    )[0]!;
    expect(batch2.status).toBe("completed");
  });

  it("a confirm-created trip assigns immediately (received → assigned), no ILLEGAL_TRANSITION (slice 015 US1)", async () => {
    const ext = uniq("SH-ASSIGN");
    const csv = [
      "trip_id,origin,destination,pickup_start,vehicle",
      `${ext},ORIG,DEST,2026-07-15 08:00,Truck`,
    ].join("\n");
    const batchId = await seedBatchWithCsv(csv);
    await runParse({ batchId, storageKey: originalStorageKey(batchId) });
    await runValidate({ batchId });
    await runDetectDuplicates({ batchId });
    await runConfirm({ batchId, actorUserId: actorId });

    const created = await db.select().from(trips).where(eq(trips.importBatchId, batchId));
    for (const t of created) createdTripIds.push(t.id);
    expect(created).toHaveLength(1);
    const trip = created[0]!;
    expect(trip.currentStatus).toBe("received"); // born received — immediately assignable.

    // Assign right away: proves `received → assigned` works with NO manual validate step. `received` is now
    // the first dispatchable status (slice 015 collapsed the validation states into it). overrideReason
    // absorbs any eligibility WARN (e.g. a vehicle-type label difference) so the transition is the focus.
    const { trip: assigned } = await assignTrip(
      trip.id,
      {
        driverId,
        vehicleId,
        expectedFromStatus: "received",
        overrideReason: "Slice 015 — teste de atribuição imediata",
      },
      actorId,
    );
    expect(assigned.currentStatus).toBe("assigned");
  });

  it("an import update to an already-assigned trip keeps its status and updates its plan (slice 015 US2, FR-002)", async () => {
    const ext = uniq("SH-UPD");
    // Batch 1 — create (born received) + assign → the trip is now `assigned` (in-flight).
    const csv1 = [
      "trip_id,origin,destination,pickup_start,vehicle",
      `${ext},ORIG,DEST,2026-08-10 08:00,Truck`,
    ].join("\n");
    const batch1 = await seedBatchWithCsv(csv1);
    await runParse({ batchId: batch1, storageKey: originalStorageKey(batch1) });
    await runValidate({ batchId: batch1 });
    await runDetectDuplicates({ batchId: batch1 });
    await runConfirm({ batchId: batch1, actorUserId: actorId });

    const created = await db.select().from(trips).where(eq(trips.importBatchId, batch1));
    for (const t of created) createdTripIds.push(t.id);
    expect(created).toHaveLength(1);
    const tripId = created[0]!.id;
    const beforePickup = created[0]!.plannedPickupWindowStart;

    const { trip: assigned } = await assignTrip(
      tripId,
      { driverId, vehicleId, expectedFromStatus: "received", overrideReason: "Slice 015 — US2 setup" },
      actorId,
    );
    expect(assigned.currentStatus).toBe("assigned");

    // Batch 2 — SAME external id, CHANGED pickup window → detect-duplicates resolves it as `update`.
    const csv2 = [
      "trip_id,origin,destination,pickup_start,vehicle",
      `${ext},ORIG,DEST,2026-08-10 14:00,Truck`,
    ].join("\n");
    const batch2 = await seedBatchWithCsv(csv2);
    await runParse({ batchId: batch2, storageKey: originalStorageKey(batch2) });
    await runValidate({ batchId: batch2 });
    await runDetectDuplicates({ batchId: batch2 });
    const updRow = (
      await db.select().from(importRows).where(eq(importRows.importBatchId, batch2))
    )[0]!;
    expect(updRow.matchDecision).toBe("update");

    await runConfirm({ batchId: batch2, actorUserId: actorId });

    // The plan changed but the status stayed `assigned` — NEVER reverted to `received` (FR-002).
    const after = (await db.select().from(trips).where(eq(trips.id, tripId)).limit(1))[0]!;
    expect(after.currentStatus).toBe("assigned");
    expect(after.plannedPickupWindowStart?.getTime()).not.toBe(beforePickup?.getTime());
  });

  it("a new row re-resolved via the unique-key race leaves an existing assigned trip's status unchanged (slice 015 US2, I2)", async () => {
    const ext = uniq("SH-RACE");
    // Setup: create (born received) + assign a trip via the normal import path.
    const csv = [
      "trip_id,origin,destination,pickup_start,vehicle",
      `${ext},ORIG,DEST,2026-09-20 08:00,Truck`,
    ].join("\n");
    const batch1 = await seedBatchWithCsv(csv);
    await runParse({ batchId: batch1, storageKey: originalStorageKey(batch1) });
    await runValidate({ batchId: batch1 });
    await runDetectDuplicates({ batchId: batch1 });
    await runConfirm({ batchId: batch1, actorUserId: actorId });
    const trip = (await db.select().from(trips).where(eq(trips.importBatchId, batch1)))[0]!;
    createdTripIds.push(trip.id);
    await assignTrip(
      trip.id,
      { driverId, vehicleId, expectedFromStatus: "received", overrideReason: "Slice 015 — race setup" },
      actorId,
    );

    // Craft a manual batch + a row FORCED to `new` whose mapped points to the SAME (customer, external
    // id). Confirm's createTrip then hits the partial-unique 23505 and re-resolves to updateTripPlan —
    // the race-fallback path — which is status-neutral by construction.
    const manualBatch = await db
      .insert(importBatches)
      .values({
        customerId,
        templateId,
        fileName: "race.csv",
        storageKey: "n/a",
        uploadedBy: actorId,
      })
      .returning();
    const manualBatchId = manualBatch[0]!.id;
    createdBatchIds.push(manualBatchId);
    await db.insert(importRows).values({
      importBatchId: manualBatchId,
      rowNumber: 1,
      raw: {},
      mapped: {
        externalTripId: ext,
        originLocationId: trip.originLocationId,
        destinationLocationId: trip.destinationLocationId,
        plannedRouteNotes: "RACE-UPDATED",
      },
      outcome: "valid",
      matchDecision: "new", // forced `new` despite the existing trip → exercises the race fallback.
    });

    await runConfirm({ batchId: manualBatchId, actorUserId: actorId });

    // No duplicate trip; the existing trip kept `assigned` and only its plan updated.
    const sameExt = await db
      .select()
      .from(trips)
      .where(and(eq(trips.customerId, customerId), eq(trips.externalTripId, ext)));
    expect(sameExt).toHaveLength(1);
    const after = sameExt[0]!;
    expect(after.id).toBe(trip.id);
    expect(after.currentStatus).toBe("assigned"); // never reverted to received.
    expect(after.plannedRouteNotes).toBe("RACE-UPDATED");
  });
});
