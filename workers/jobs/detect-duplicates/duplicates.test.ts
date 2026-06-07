import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  customers,
  alerts,
  db,
  importBatches,
  importRows,
  importTemplates,
  locations,
  transitionTripStatus,
  tripEvents,
  trips,
  users,
} from "@brazil-tms/db";
import { originalStorageKey, putOriginal } from "@brazil-tms/db/storage";
import type { PgBoss } from "pg-boss";
import { IMPORT_JOBS } from "@brazil-tms/shared";
import { runParse } from "../parse";
import { runValidate } from "../validate";
import { registerDetectDuplicates, runDetectDuplicates } from "./index";
import { runConfirm } from "../confirm-import";

/**
 * A minimal fake pg-boss that captures the handler registered via `work(...)` and records every
 * `send(...)`. Lets us exercise the detect-duplicates REGISTER WRAPPER (which decides whether to
 * enqueue generate-error-report) without booting a real queue — the gap that let a stale worker ship
 * batches with errors but no report.
 */
function makeFakeBoss() {
  const sends: { name: string; data: unknown }[] = [];
  let captured: ((jobs: { data: unknown }[]) => Promise<unknown>) | null = null;
  const boss = {
    work: async (_name: string, handler: (jobs: { data: unknown }[]) => Promise<unknown>) => {
      captured = handler;
      return "work-id";
    },
    send: async (name: string, data: unknown) => {
      sends.push({ name, data });
      return "job-id";
    },
  };
  return {
    boss: boss as unknown as PgBoss,
    sends,
    invoke: (data: unknown) => captured?.([{ data }]),
  };
}

/**
 * T047 — detect-duplicates integration test (US3) via the run* pipeline against the live dev DB +
 * Storage. Covers the matching/duplicate semantics (R7): identical re-import → all no_op (0 new,
 * SC-002); a changed plan field on a known external id → update with `original_plan` preserved + a
 * `trip.plan_update` audit row; an id-less look-alike → potential_duplicate (created with a recorded
 * reason); two same-id rows in one file → both error/IN_FILE_COLLISION (none created, FR-017a); an
 * update to a trip moved PAST `confirmed` without review → needs-review (REVIEW_REQUIRED, not applied,
 * FR-024). Static imports per project convention; skips without DATABASE_URL.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("detect-duplicates job — full pipeline (integration)", () => {
  let actorId = "";
  let customerId = "";
  let templateId = "";
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
      .values({ name: "Cliente Import Dedup", customerCode: uniq("CUST-DEDUP") })
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
        name: uniq("Template Dedup"),
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
  });

  afterAll(async () => {
    // FK-safe teardown: import_rows (target_trip_id → trips) and trip_events (trip_id → trips) must go
    // before trips; trips (import_batch_id → import_batches) must go before import_batches.
    for (const batchId of createdBatchIds) {
      await db.delete(importRows).where(eq(importRows.importBatchId, batchId));
    }
    for (const tripId of createdTripIds) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, tripId));
    }
    if (createdTripIds.length > 0) {
      await db.delete(tripEvents).where(inArray(tripEvents.tripId, createdTripIds));
      await db.delete(alerts).where(inArray(alerts.tripId, createdTripIds));
      await db.delete(trips).where(inArray(trips.id, createdTripIds));
    }
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

  /** Run the full read pipeline (parse → validate → detect) for a batch. */
  async function runPipeline(batchId: string): Promise<void> {
    await runParse({ batchId, storageKey: originalStorageKey(batchId) });
    await runValidate({ batchId });
    await runDetectDuplicates({ batchId });
  }

  async function rowsOf(batchId: string) {
    return db
      .select()
      .from(importRows)
      .where(eq(importRows.importBatchId, batchId))
      .orderBy(asc(importRows.rowNumber));
  }

  function reasonCodes(reasons: unknown): string[] {
    return Array.isArray(reasons) ? (reasons as { code: string }[]).map((r) => r.code) : [];
  }

  async function trackTripsFor(batchId: string): Promise<void> {
    const created = await db.select({ id: trips.id }).from(trips).where(eq(trips.importBatchId, batchId));
    for (const t of created) if (!createdTripIds.includes(t.id)) createdTripIds.push(t.id);
  }

  it("(a) identical re-import of a confirmed batch → all no_op; re-confirm creates 0 new (SC-002)", async () => {
    const ext = uniq("SH-NOOP");
    const csv = [
      "trip_id,origin,destination,pickup_start,vehicle",
      `${ext},ORIG,DEST,2026-06-01 08:00,Truck`,
    ].join("\n");

    const batch1 = await seedBatchWithCsv(csv);
    await runPipeline(batch1);
    await runConfirm({ batchId: batch1, actorUserId: actorId });
    await trackTripsFor(batch1);

    const tripsAfter1 = await db
      .select({ id: trips.id })
      .from(trips)
      .where(and(eq(trips.customerId, customerId), eq(trips.externalTripId, ext)));
    expect(tripsAfter1).toHaveLength(1);

    // Re-import the IDENTICAL file.
    const batch2 = await seedBatchWithCsv(csv);
    await runPipeline(batch2);
    const rows2 = await rowsOf(batch2);
    expect(rows2).toHaveLength(1);
    expect(rows2[0]!.matchDecision).toBe("no_op");

    await runConfirm({ batchId: batch2, actorUserId: actorId });
    await trackTripsFor(batch2);

    const tripsAfter2 = await db
      .select({ id: trips.id })
      .from(trips)
      .where(and(eq(trips.customerId, customerId), eq(trips.externalTripId, ext)));
    expect(tripsAfter2).toHaveLength(1); // 0 new
  });

  it("(b) changed plan field on a known external id → update; original_plan preserved + plan_update audit", async () => {
    const ext = uniq("SH-UPD");
    const csv1 = [
      "trip_id,origin,destination,pickup_start,vehicle",
      `${ext},ORIG,DEST,2026-06-01 08:00,Truck`,
    ].join("\n");

    const batch1 = await seedBatchWithCsv(csv1);
    await runPipeline(batch1);
    await runConfirm({ batchId: batch1, actorUserId: actorId });
    await trackTripsFor(batch1);

    const originalTrip = (
      await db
        .select()
        .from(trips)
        .where(and(eq(trips.customerId, customerId), eq(trips.externalTripId, ext)))
        .limit(1)
    )[0]!;
    const originalPlanSnapshot = JSON.stringify(originalTrip.originalPlan);

    // Re-import with a CHANGED pickup window (a critical plan field).
    const csv2 = [
      "trip_id,origin,destination,pickup_start,vehicle",
      `${ext},ORIG,DEST,2026-06-05 14:00,Truck`,
    ].join("\n");
    const batch2 = await seedBatchWithCsv(csv2);
    await runPipeline(batch2);

    const rows2 = await rowsOf(batch2);
    expect(rows2[0]!.matchDecision).toBe("update");

    await runConfirm({ batchId: batch2, actorUserId: actorId });

    const updatedTrip = (
      await db.select().from(trips).where(eq(trips.id, originalTrip.id)).limit(1)
    )[0]!;
    // original_plan is the IMMUTABLE snapshot → unchanged.
    expect(JSON.stringify(updatedTrip.originalPlan)).toBe(originalPlanSnapshot);
    // The live planned window moved.
    expect(updatedTrip.plannedPickupWindowStart!.getTime()).not.toBe(
      originalTrip.plannedPickupWindowStart!.getTime(),
    );

    // A trip.plan_update audit row exists for the trip.
    const planAudit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, originalTrip.id), eq(auditLogs.action, "trip.plan_update")));
    expect(planAudit.length).toBeGreaterThanOrEqual(1);
  });

  it("(c) a look-alike with a NEW external id (no exact match) but same plan → potential_duplicate, created with reason", async () => {
    // NOTE on "id-less": validate flags a BLANK external id as an error (MISSING_EXTERNAL_ID), so a
    // literally id-less row never reaches the fuzzy pass — it is `error`/`unresolved`. The realistic
    // potential-duplicate (FR-022) is therefore the same trip re-sent under a DIFFERENT/new external id:
    // no EXACT `(customer, external_trip_id)` match (so it would be `new`), but the plan fuzzy-matches an
    // existing trip (same origin/destination/pickup-DAY/vehicle within the documented-default tolerance).
    const ext = uniq("SH-FUZZ");
    const csv1 = [
      "trip_id,origin,destination,pickup_start,vehicle",
      `${ext},ORIG,DEST,2026-07-01 08:00,Truck`,
    ].join("\n");
    const batch1 = await seedBatchWithCsv(csv1);
    await runPipeline(batch1);
    await runConfirm({ batchId: batch1, actorUserId: actorId });
    await trackTripsFor(batch1);

    // A second file with a DIFFERENT external id but the SAME origin/destination/pickup-DAY/vehicle → fuzzy hit.
    const csv2 = [
      "trip_id,origin,destination,pickup_start,vehicle",
      `${uniq("SH-FUZZ-NEW")},ORIG,DEST,2026-07-01 18:00,Truck`,
    ].join("\n");
    const batch2 = await seedBatchWithCsv(csv2);
    await runPipeline(batch2);

    const rows2 = await rowsOf(batch2);
    expect(rows2).toHaveLength(1);
    expect(rows2[0]!.matchDecision).toBe("potential_duplicate");
    expect(rows2[0]!.outcome).toBe("warning");
    expect(reasonCodes(rows2[0]!.reasons)).toContain("POTENTIAL_DUPLICATE");

    const dupBatch = await db
      .select({ duplicateCount: importBatches.duplicateCount })
      .from(importBatches)
      .where(eq(importBatches.id, batch2))
      .limit(1);
    expect(dupBatch[0]!.duplicateCount).toBe(1);

    // Confirm applies it (created WITH the recorded reason still on the row).
    await runConfirm({ batchId: batch2, actorUserId: actorId });
    await trackTripsFor(batch2);
    const appliedRows = await rowsOf(batch2);
    expect(appliedRows[0]!.appliedAt).not.toBeNull();
    expect(appliedRows[0]!.targetTripId).not.toBeNull();
    expect(reasonCodes(appliedRows[0]!.reasons)).toContain("POTENTIAL_DUPLICATE");
  });

  it("(d) two rows sharing (customer, external id) in one file → both error IN_FILE_COLLISION, none created", async () => {
    const ext = uniq("SH-COLLIDE");
    const csv = [
      "trip_id,origin,destination,pickup_start,vehicle",
      `${ext},ORIG,DEST,2026-08-01 08:00,Truck`,
      `${ext},ORIG,DEST,2026-08-02 09:00,Carreta`,
    ].join("\n");

    const batchId = await seedBatchWithCsv(csv);
    await runPipeline(batchId);

    const rows = await rowsOf(batchId);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.outcome).toBe("error");
      expect(r.matchDecision).toBe("unresolved");
      expect(reasonCodes(r.reasons)).toContain("IN_FILE_COLLISION");
    }

    await runConfirm({ batchId, actorUserId: actorId });
    await trackTripsFor(batchId);
    const created = await db.select().from(trips).where(eq(trips.importBatchId, batchId));
    expect(created).toHaveLength(0);
  });

  it("(e) update to a trip moved PAST confirmed without review → needs-review (REVIEW_REQUIRED, not applied)", async () => {
    const ext = uniq("SH-REVIEW");
    const csv1 = [
      "trip_id,origin,destination,pickup_start,vehicle",
      `${ext},ORIG,DEST,2026-09-01 08:00,Truck`,
    ].join("\n");
    const batch1 = await seedBatchWithCsv(csv1);
    await runPipeline(batch1);
    await runConfirm({ batchId: batch1, actorUserId: actorId });
    await trackTripsFor(batch1);

    const trip = (
      await db
        .select()
        .from(trips)
        .where(and(eq(trips.customerId, customerId), eq(trips.externalTripId, ext)))
        .limit(1)
    )[0]!;

    // Move the trip PAST `confirmed` via the legal 003 path. Imported trips are born `validated`
    // (slice 014), so the walk starts there: validated → assigned → confirmed → at_origin.
    await transitionTripStatus(trip.id, { expectedFromStatus: "validated", toStatus: "assigned" }, actorId);
    await transitionTripStatus(trip.id, { expectedFromStatus: "assigned", toStatus: "confirmed" }, actorId);
    await transitionTripStatus(trip.id, { expectedFromStatus: "confirmed", toStatus: "at_origin" }, actorId);

    // Re-import with a changed plan field → would be an `update`, but the trip is past confirmed.
    const csv2 = [
      "trip_id,origin,destination,pickup_start,vehicle",
      `${ext},ORIG,DEST,2026-09-10 12:00,Truck`,
    ].join("\n");
    const batch2 = await seedBatchWithCsv(csv2);
    await runPipeline(batch2);
    const rows2 = await rowsOf(batch2);
    expect(rows2[0]!.matchDecision).toBe("update");

    await runConfirm({ batchId: batch2, actorUserId: actorId });

    const reviewRow = (await rowsOf(batch2))[0]!;
    expect(reviewRow.appliedAt).toBeNull(); // reported, NOT applied
    expect(reviewRow.targetTripId).toBeNull();
    expect(reasonCodes(reviewRow.reasons)).toContain("REVIEW_REQUIRED");
    // SURFACED, not hidden behind a "completed" batch: the unapplied row is marked error so it is
    // counted in error_count (and would appear in the regenerated error report) — never silently lost.
    expect(reviewRow.outcome).toBe("error");
    const batchAfter = (
      await db
        .select({ errorCount: importBatches.errorCount, status: importBatches.status })
        .from(importBatches)
        .where(eq(importBatches.id, batch2))
        .limit(1)
    )[0]!;
    expect(batchAfter.errorCount).toBeGreaterThanOrEqual(1);

    // The trip's live plan was NOT silently changed.
    const stillTrip = (await db.select().from(trips).where(eq(trips.id, trip.id)).limit(1))[0]!;
    expect(stillTrip.plannedPickupWindowStart!.getTime()).toBe(
      trip.plannedPickupWindowStart!.getTime(),
    );
  });

  it("the register wrapper ENQUEUES generate-error-report when the batch has errors (pg-boss chain)", async () => {
    const batch = await db
      .insert(importBatches)
      .values({
        customerId,
        templateId,
        fileName: "wiring-err.csv",
        storageKey: "n/a",
        uploadedBy: actorId,
        status: "validating",
      })
      .returning();
    const batchId = batch[0]!.id;
    createdBatchIds.push(batchId);
    // One already-error row → runDetectDuplicates tallies error_count = 1.
    await db.insert(importRows).values({
      importBatchId: batchId,
      rowNumber: 1,
      raw: {},
      mapped: { externalTripId: "ERR-1" },
      outcome: "error",
      reasons: [{ code: "UNKNOWN_LOCATION", message: "x" }],
    });

    const fake = makeFakeBoss();
    await registerDetectDuplicates(fake.boss);
    await fake.invoke({ batchId });

    expect(
      fake.sends.some(
        (s) =>
          s.name === IMPORT_JOBS.generateErrorReport &&
          (s.data as { batchId?: string }).batchId === batchId,
      ),
    ).toBe(true);
  });

  it("the register wrapper does NOT enqueue generate-error-report when the batch has no errors", async () => {
    const batch = await db
      .insert(importBatches)
      .values({
        customerId,
        templateId,
        fileName: "wiring-ok.csv",
        storageKey: "n/a",
        uploadedBy: actorId,
        status: "validating",
      })
      .returning();
    const batchId = batch[0]!.id;
    createdBatchIds.push(batchId);
    // One clean valid row with a unique external id → matches nothing → `new`, error_count = 0.
    await db.insert(importRows).values({
      importBatchId: batchId,
      rowNumber: 1,
      raw: {},
      mapped: { externalTripId: uniq("OK") },
      outcome: "valid",
    });

    const fake = makeFakeBoss();
    await registerDetectDuplicates(fake.boss);
    await fake.invoke({ batchId });

    expect(fake.sends.some((s) => s.name === IMPORT_JOBS.generateErrorReport)).toBe(false);
  });
});
