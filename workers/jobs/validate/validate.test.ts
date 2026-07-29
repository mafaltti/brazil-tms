import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  customers,
  alerts,
  db,
  importBatches,
  importRows,
  importTemplates,
  locations,
  statusMappings,
  trips,
  users,
} from "@brazil-tms/db";
import { originalStorageKey, putOriginal } from "@brazil-tms/db/storage";
import { runParse } from "../parse";
import { runValidate } from "./index";
import { runDetectDuplicates } from "../detect-duplicates";
import { runGenerateErrorReport } from "../generate-error-report";
import { runConfirm } from "../confirm-import";

/**
 * T044 — validate job integration test (US2). Drives parse → validate against the live dev DB + Storage
 * and asserts per-row `outcome` + localized `reasons` for the four validation classes (missing required
 * field, inactive customer, invalid/unordered window, unmappable vehicle type), then proves error rows
 * are excluded by a subsequent confirm (an all-error batch creates 0 trips) and that the error-report
 * path produces a non-null `error_report_storage_key`. Static imports per project convention; skips
 * without DATABASE_URL.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("validate job (integration)", () => {
  let actorId = "";
  let customerId = "";
  let archivedCustomerId = "";
  let templateId = "";
  let archivedTemplateId = "";
  const createdBatchIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdTripIds: string[] = [];

  function uniq(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  /** A template mapping both window ends (so INVALID_WINDOW is reachable) + an optional required override. */
  async function seedTemplate(forCustomer: string, requiredOverrides: string[]): Promise<string> {
    const template = await db
      .insert(importTemplates)
      .values({
        customerId: forCustomer,
        name: uniq("Template Validate"),
        version: 1,
        fileType: "csv",
        columnMappings: [
          { source: "trip_id", target: "externalTripId" },
          { source: "origin", target: "originCode" },
          { source: "destination", target: "destinationCode" },
          { source: "pickup_start", target: "plannedPickupWindowStart" },
          { source: "pickup_end", target: "plannedPickupWindowEnd" },
          { source: "vehicle", target: "plannedVehicleType" },
        ],
        parsingRules: {
          dateFormats: ["yyyy-MM-dd HH:mm"],
          timezone: "America/Sao_Paulo",
          decimalSeparator: ",",
          thousandSeparator: ".",
        },
        requiredOverrides,
      })
      .returning();
    return template[0]!.id;
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
      .values({ name: "Cliente Import Validate", customerCode: uniq("CUST-VAL") })
      .returning();
    customerId = customer[0]!.id;
    createdCustomerIds.push(customerId);

    const archived = await db
      .insert(customers)
      .values({
        name: "Cliente Import Validate Arquivado",
        customerCode: uniq("CUST-VAL-ARCH"),
        archivedAt: new Date(),
      })
      .returning();
    archivedCustomerId = archived[0]!.id;
    createdCustomerIds.push(archivedCustomerId);

    await db.insert(locations).values([
      { customerId, code: "ORIG", name: "Origem", country: "BR" },
      { customerId, code: "DEST", name: "Destino", country: "BR" },
    ]);
    await db.insert(locations).values([
      { customerId: archivedCustomerId, code: "ORIG", name: "Origem", country: "BR" },
      { customerId: archivedCustomerId, code: "DEST", name: "Destino", country: "BR" },
    ]);

    // The active customer's template forces externalTripId required (so a blank id → MISSING_REQUIRED_FIELD).
    templateId = await seedTemplate(customerId, ["externalTripId"]);
    archivedTemplateId = await seedTemplate(archivedCustomerId, []);
  });

  afterAll(async () => {
    for (const batchId of createdBatchIds) {
      await db.delete(importRows).where(eq(importRows.importBatchId, batchId));
    }
    for (const tripId of createdTripIds) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, tripId));
    }
    // Trips (import_batch_id → import_batches) must go before the batches they reference.
    if (createdTripIds.length > 0) {
      await db.delete(alerts).where(inArray(alerts.tripId, createdTripIds));
      await db.delete(trips).where(inArray(trips.id, createdTripIds));
    }
    for (const batchId of createdBatchIds) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, batchId));
      await db.delete(importBatches).where(eq(importBatches.id, batchId));
    }
    for (const cid of createdCustomerIds) {
      await db.delete(importTemplates).where(eq(importTemplates.customerId, cid));
      await db.delete(statusMappings).where(eq(statusMappings.customerId, cid));
      await db.delete(locations).where(eq(locations.customerId, cid));
      await db.delete(auditLogs).where(eq(auditLogs.entityId, cid));
      await db.delete(customers).where(eq(customers.id, cid));
    }
  });

  async function seedBatchWithCsv(
    csv: string,
    forCustomer: string,
    forTemplate: string,
  ): Promise<string> {
    const batch = await db
      .insert(importBatches)
      .values({
        customerId: forCustomer,
        templateId: forTemplate,
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

  async function rowsOf(batchId: string) {
    return db
      .select()
      .from(importRows)
      .where(eq(importRows.importBatchId, batchId))
      .orderBy(asc(importRows.rowNumber));
  }

  function reasonCodes(reasons: unknown): string[] {
    return Array.isArray(reasons)
      ? (reasons as { code: string }[]).map((r) => r.code)
      : [];
  }

  it("classifies missing-required, invalid-window, and unmappable-vehicle rows; warning row stays valid-ish", async () => {
    const csv = [
      "trip_id,origin,destination,pickup_start,pickup_end,vehicle",
      // row 1: missing required externalTripId (template forces it required) → error
      ",ORIG,DEST,2026-06-01 08:00,2026-06-01 10:00,Truck",
      // row 2: pickup start AFTER end → INVALID_WINDOW error
      `${uniq("SH-WIN")},ORIG,DEST,2026-06-01 10:00,2026-06-01 08:00,Truck`,
      // row 3: unmappable vehicle type → warning (never blocks)
      `${uniq("SH-VEH")},ORIG,DEST,2026-06-02 08:00,2026-06-02 10:00,Spaceship`,
    ].join("\n");

    const batchId = await seedBatchWithCsv(csv, customerId, templateId);
    await runParse({ batchId, storageKey: originalStorageKey(batchId) });
    await runValidate({ batchId });

    const rows = await rowsOf(batchId);
    expect(rows).toHaveLength(3);

    expect(rows[0]!.outcome).toBe("error");
    expect(reasonCodes(rows[0]!.reasons)).toContain("MISSING_REQUIRED_FIELD");

    expect(rows[1]!.outcome).toBe("error");
    expect(reasonCodes(rows[1]!.reasons)).toContain("INVALID_WINDOW");

    expect(rows[2]!.outcome).toBe("warning");
    expect(reasonCodes(rows[2]!.reasons)).toContain("UNMAPPABLE_VEHICLE_TYPE");
  });

  it("an archived (inactive) customer makes every row INACTIVE_CUSTOMER error; confirm creates 0 trips", async () => {
    const csv = [
      "trip_id,origin,destination,pickup_start,pickup_end,vehicle",
      `${uniq("SH-INACT-A")},ORIG,DEST,2026-06-01 08:00,2026-06-01 10:00,Truck`,
      `${uniq("SH-INACT-B")},ORIG,DEST,2026-06-02 08:00,2026-06-02 10:00,Carreta`,
    ].join("\n");

    const batchId = await seedBatchWithCsv(csv, archivedCustomerId, archivedTemplateId);
    await runParse({ batchId, storageKey: originalStorageKey(batchId) });
    await runValidate({ batchId });

    const rows = await rowsOf(batchId);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.outcome).toBe("error");
      expect(reasonCodes(r.reasons)).toContain("INACTIVE_CUSTOMER");
    }

    // Error rows are excluded on confirm → an all-error batch creates 0 trips.
    await runDetectDuplicates({ batchId });
    await runConfirm({ batchId, actorUserId: actorId });
    const created = await db.select().from(trips).where(eq(trips.importBatchId, batchId));
    for (const t of created) createdTripIds.push(t.id);
    expect(created).toHaveLength(0);
  });

  it("a batch with error rows generates a downloadable error report (error_report_storage_key set)", async () => {
    const csv = [
      "trip_id,origin,destination,pickup_start,pickup_end,vehicle",
      // one good row + one error row (invalid window) → error_count > 0
      `${uniq("SH-OK")},ORIG,DEST,2026-06-01 08:00,2026-06-01 10:00,Truck`,
      `${uniq("SH-BAD")},ORIG,DEST,2026-06-01 10:00,2026-06-01 08:00,Truck`,
    ].join("\n");

    const batchId = await seedBatchWithCsv(csv, customerId, templateId);
    await runParse({ batchId, storageKey: originalStorageKey(batchId) });
    await runValidate({ batchId });
    await runDetectDuplicates({ batchId });

    const beforeReport = await db
      .select({ errorCount: importBatches.errorCount, key: importBatches.errorReportStorageKey })
      .from(importBatches)
      .where(eq(importBatches.id, batchId))
      .limit(1);
    expect(beforeReport[0]!.errorCount).toBeGreaterThan(0);

    await runGenerateErrorReport({ batchId });

    const afterReport = await db
      .select({ key: importBatches.errorReportStorageKey })
      .from(importBatches)
      .where(eq(importBatches.id, batchId))
      .limit(1);
    expect(afterReport[0]!.key).not.toBeNull();
    expect(afterReport[0]!.key).toContain(batchId);

    // The good row still applies; the error row is excluded.
    await runConfirm({ batchId, actorUserId: actorId });
    const created = await db.select().from(trips).where(eq(trips.importBatchId, batchId));
    for (const t of created) createdTripIds.push(t.id);
    expect(created).toHaveLength(1);
  });

  it("flags an unmapped customer status label as a warning; a mapped label passes (R10)", async () => {
    // A template that also maps the file's `status` column → statusLabel.
    const tplWithStatus = await db
      .insert(importTemplates)
      .values({
        customerId,
        name: uniq("Template Status"),
        version: 1,
        fileType: "csv",
        columnMappings: [
          { source: "trip_id", target: "externalTripId" },
          { source: "origin", target: "originCode" },
          { source: "destination", target: "destinationCode" },
          { source: "status", target: "statusLabel" },
        ],
        parsingRules: {
          dateFormats: [],
          timezone: "America/Sao_Paulo",
          decimalSeparator: ",",
          thousandSeparator: ".",
        },
        requiredOverrides: [],
      })
      .returning();
    const tplId = tplWithStatus[0]!.id;

    // The customer's configured status vocabulary: "Planejada" → received (record/validate only).
    await db
      .insert(statusMappings)
      .values({ customerId, customerLabel: "Planejada", internalStatus: "received" });

    const csv = [
      "trip_id,origin,destination,status",
      `${uniq("SH-ST-OK")},ORIG,DEST,Planejada`,
      `${uniq("SH-ST-UNK")},ORIG,DEST,Desconhecido`,
    ].join("\n");
    const batchId = await seedBatchWithCsv(csv, customerId, tplId);
    await runParse({ batchId, storageKey: originalStorageKey(batchId) });
    await runValidate({ batchId });

    const rows = await rowsOf(batchId);
    expect(rows).toHaveLength(2);
    // A mapped label is silent; an unknown label is a WARNING (recorded, never blocks — R10).
    expect(reasonCodes(rows[0]!.reasons)).not.toContain("UNMAPPED_STATUS");
    expect(reasonCodes(rows[1]!.reasons)).toContain("UNMAPPED_STATUS");
    expect(rows[1]!.outcome).toBe("warning");
  });
});
