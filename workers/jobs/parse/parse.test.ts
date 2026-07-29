import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  auditLogs,
  customers,
  db,
  importBatches,
  importRows,
  importTemplates,
  locations,
  users,
} from "@brazil-tms/db";
import { originalStorageKey, putOriginal } from "@brazil-tms/db/storage";
import { runParse } from "./index";

/**
 * T038 — parse job integration test against the live dev DB + Storage. Static imports per project
 * convention (the Drizzle client + Supabase client connect lazily, so importing is safe). Skips when
 * DATABASE_URL is unset so the default `pnpm test` stays green. To run it:
 *   $env:DATABASE_URL='...'; $env:SUPABASE_URL='...'; $env:SUPABASE_SERVICE_ROLE_KEY='...';
 *   pnpm exec vitest run --project workers
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("parse job (integration)", () => {
  let actorId = "";
  let customerId = "";
  let templateId = "";
  const createdBatchIds: string[] = [];
  const createdCustomerIds: string[] = [];

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
      .values({ name: "Cliente Import Parse", customerCode: uniq("CUST-PARSE") })
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
        name: uniq("Template Parse"),
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
    for (const batchId of createdBatchIds) {
      await db.delete(importRows).where(eq(importRows.importBatchId, batchId));
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

  async function seedBatchWith(opts: {
    templateId: string | null;
    fileName: string;
  }): Promise<string> {
    const batch = await db
      .insert(importBatches)
      .values({
        customerId,
        templateId: opts.templateId,
        fileName: opts.fileName,
        storageKey: "pending",
        uploadedBy: actorId,
      })
      .returning();
    const batchId = batch[0]!.id;
    createdBatchIds.push(batchId);
    const key = originalStorageKey(batchId);
    await db.update(importBatches).set({ storageKey: key }).where(eq(importBatches.id, batchId));
    return batchId;
  }

  function seedBatch(): Promise<string> {
    return seedBatchWith({ templateId, fileName: "trips.csv" });
  }

  /** Build an XLSX buffer (header row + data rows) the parse worker reads via the .xlsx extension. */
  async function buildXlsx(headers: string[], rows: string[][]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow(headers);
    for (const row of rows) sheet.addRow(row);
    const arrayBuffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer as ArrayBuffer);
  }

  // The slice-013 standard headers (mirrors STANDARD_IMPORT_TEMPLATE.columnMappings, in order).
  const STD_HEADERS = [
    "id_viagem",
    "origem",
    "destino",
    "janela_coleta_inicio",
    "janela_coleta_fim",
    "janela_entrega_inicio",
    "janela_entrega_fim",
    "tipo_veiculo",
    "status",
  ];

  it("parses CSV into import_rows with 1-based row_number, mapped fields, and total_rows", async () => {
    const csv = [
      "trip_id,origin,destination,pickup_start,vehicle",
      "SH-1,ORIG,DEST,2026-06-01 08:00,Truck",
      "SH-2,ORIG,DEST,2026-06-02 09:30,Carreta",
    ].join("\n");

    const batchId = await seedBatch();
    await putOriginal(batchId, Buffer.from(csv, "utf-8"), "text/csv");

    await runParse({ batchId, storageKey: originalStorageKey(batchId) });

    const rows = await db
      .select()
      .from(importRows)
      .where(eq(importRows.importBatchId, batchId))
      .orderBy(asc(importRows.rowNumber));

    expect(rows).toHaveLength(2);
    expect(rows[0]!.rowNumber).toBe(1);
    expect(rows[1]!.rowNumber).toBe(2);

    const mapped0 = rows[0]!.mapped as Record<string, unknown>;
    expect(mapped0.externalTripId).toBe("SH-1");
    expect(mapped0.originCode).toBe("ORIG");
    expect(mapped0.destinationCode).toBe("DEST");
    expect(mapped0.plannedVehicleType).toBe("Truck");
    // The pickup date normalized to a UTC instant, serialized to ISO in jsonb.
    expect(typeof mapped0.plannedPickupWindowStart).toBe("string");
    expect(rows[0]!.raw).toMatchObject({ trip_id: "SH-1", origin: "ORIG" });

    const batchRows = await db
      .select({ totalRows: importBatches.totalRows, status: importBatches.status })
      .from(importBatches)
      .where(eq(importBatches.id, batchId))
      .limit(1);
    expect(batchRows[0]!.totalRows).toBe(2);
    expect(batchRows[0]!.status).toBe("parsing");
  });

  it("header-only CSV yields total_rows 0 and inserts no rows", async () => {
    const csv = "trip_id,origin,destination,pickup_start,vehicle\n";
    const batchId = await seedBatch();
    await putOriginal(batchId, Buffer.from(csv, "utf-8"), "text/csv");

    await runParse({ batchId, storageKey: originalStorageKey(batchId) });

    const rows = await db
      .select()
      .from(importRows)
      .where(eq(importRows.importBatchId, batchId));
    expect(rows).toHaveLength(0);

    const batchRows = await db
      .select({ totalRows: importBatches.totalRows })
      .from(importBatches)
      .where(eq(importBatches.id, batchId))
      .limit(1);
    expect(batchRows[0]!.totalRows).toBe(0);
  });

  it("a batch with NO template is mapped via the standard format (slice 013 — no batch failure)", async () => {
    const csv = [
      STD_HEADERS.join(","),
      "STD-1,ORIG,DEST,01/06/2026 08:00,01/06/2026 10:00,02/06/2026 08:00,02/06/2026 12:00,Truck,Novo",
      "STD-2,ORIG,DEST,03/06/2026 08:00,03/06/2026 10:00,04/06/2026 08:00,04/06/2026 12:00,Carreta,Novo",
    ].join("\n");

    const batchId = await seedBatchWith({ templateId: null, fileName: "standard.csv" });
    await putOriginal(batchId, Buffer.from(csv, "utf-8"), "text/csv");

    await runParse({ batchId, storageKey: originalStorageKey(batchId) });

    const rows = await db
      .select()
      .from(importRows)
      .where(eq(importRows.importBatchId, batchId))
      .orderBy(asc(importRows.rowNumber));
    expect(rows).toHaveLength(2);

    const mapped0 = rows[0]!.mapped as Record<string, unknown>;
    expect(mapped0.externalTripId).toBe("STD-1");
    expect(mapped0.originCode).toBe("ORIG");
    expect(mapped0.destinationCode).toBe("DEST");
    expect(mapped0.plannedVehicleType).toBe("Truck");
    expect(mapped0.statusLabel).toBe("Novo");
    // Mapping did not throw → no per-row MAPPING_ERROR was recorded.
    expect(rows[0]!.outcome).toBeNull();

    const batchRows = await db
      .select({
        status: importBatches.status,
        totalRows: importBatches.totalRows,
        errorMessage: importBatches.errorMessage,
      })
      .from(importBatches)
      .where(eq(importBatches.id, batchId))
      .limit(1);
    // The null-template path no longer fails the batch (FR-005); it advances exactly like a templated one.
    expect(batchRows[0]!.status).not.toBe("failed");
    expect(batchRows[0]!.errorMessage).toBeNull();
    expect(batchRows[0]!.totalRows).toBe(2);
  });

  it("a no-template XLSX batch is parsed via the extension-chosen reader (slice 013)", async () => {
    const bytes = await buildXlsx(STD_HEADERS, [
      ["XL-1", "ORIG", "DEST", "01/06/2026 08:00", "01/06/2026 10:00", "02/06/2026 08:00", "02/06/2026 12:00", "Truck", "Novo"],
    ]);

    const batchId = await seedBatchWith({ templateId: null, fileName: "standard.xlsx" });
    await putOriginal(
      batchId,
      bytes,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );

    await runParse({ batchId, storageKey: originalStorageKey(batchId) });

    const rows = await db
      .select()
      .from(importRows)
      .where(eq(importRows.importBatchId, batchId))
      .orderBy(asc(importRows.rowNumber));
    expect(rows).toHaveLength(1);
    const mapped0 = rows[0]!.mapped as Record<string, unknown>;
    expect(mapped0.externalTripId).toBe("XL-1");
    expect(mapped0.originCode).toBe("ORIG");
    expect(mapped0.destinationCode).toBe("DEST");

    const batchRows = await db
      .select({ status: importBatches.status, totalRows: importBatches.totalRows })
      .from(importBatches)
      .where(eq(importBatches.id, batchId))
      .limit(1);
    expect(batchRows[0]!.status).not.toBe("failed");
    expect(batchRows[0]!.totalRows).toBe(1);
  });

  it("a CSV with a leading UTF-8 BOM still maps the first column (Excel/sample exports)", async () => {
    // The in-app sample download and most Excel/Sheets CSV exports prepend a BOM. Without bom-stripping
    // the first header parses as "\uFEFFid_viagem" and externalTripId silently misses → MISSING_EXTERNAL_ID.
    const csv = [
      STD_HEADERS.join(","),
      "BOM-1,ORIG,DEST,01/06/2026 08:00,01/06/2026 10:00,02/06/2026 08:00,02/06/2026 12:00,Truck,Novo",
    ].join("\n");
    const batchId = await seedBatchWith({ templateId: null, fileName: "bom.csv" });
    await putOriginal(batchId, Buffer.from(`\uFEFF${csv}`, "utf-8"), "text/csv");

    await runParse({ batchId, storageKey: originalStorageKey(batchId) });

    const rows = await db
      .select()
      .from(importRows)
      .where(eq(importRows.importBatchId, batchId))
      .orderBy(asc(importRows.rowNumber));
    expect(rows).toHaveLength(1);
    const mapped0 = rows[0]!.mapped as Record<string, unknown>;
    // The BOM must not corrupt the first header — externalTripId resolves from `id_viagem`.
    expect(mapped0.externalTripId).toBe("BOM-1");
    expect(mapped0.originCode).toBe("ORIG");
  });

  it("re-running parse is idempotent (retry-safe): no duplicate-key error, same row count", async () => {
    const csv = [
      "trip_id,origin,destination,pickup_start,vehicle",
      "RE-1,ORIG,DEST,2026-06-01 08:00,Truck",
      "RE-2,ORIG,DEST,2026-06-02 09:30,Carreta",
    ].join("\n");
    const batchId = await seedBatch();
    await putOriginal(batchId, Buffer.from(csv, "utf-8"), "text/csv");

    await runParse({ batchId, storageKey: originalStorageKey(batchId) });
    // A pg-boss retry re-invokes parse on the same batch; the (import_batch_id, row_number) unique
    // index must NOT break it. Prior staging is cleared + re-inserted, so the re-run resolves cleanly.
    await expect(
      runParse({ batchId, storageKey: originalStorageKey(batchId) }),
    ).resolves.toBeUndefined();

    const rows = await db
      .select()
      .from(importRows)
      .where(eq(importRows.importBatchId, batchId));
    expect(rows).toHaveLength(2);
  });
});
