import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { applyTemplate, templateConfigSchema } from "@brazil-tms/shared";
import { cellToString, parseXlsxBytes } from "./index";

/**
 * Slice 013 — typed xlsx date cells (pure unit test; no DB, always runs). Real customer files (Shopee
 * linehaul tenders) store dates as typed Excel datetime cells, NOT as text in the template's
 * `dd/MM/yyyy` format. ExcelJS hands those back as JS `Date`s; the worker must emit a ZONE-LESS ISO
 * datetime so the engine interprets the wall-clock in the template timezone. Regression guard for the
 * "every row → MAPPING_ERROR / UNPARSEABLE_DATE" bug on xlsx imports.
 */

async function xlsxBuffer(rows: (string | Date)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// 2026-06-07 15:00 as a typed cell — ExcelJS round-trips its UTC fields as the spreadsheet wall-clock.
const ETA = new Date(Date.UTC(2026, 5, 7, 15, 0, 0));

describe("cellToString", () => {
  it("emits a zone-less ISO datetime for Date cells (drops the trailing Z)", () => {
    expect(cellToString(ETA)).toBe("2026-06-07T15:00:00.000");
  });

  it("leaves null/empty and plain strings unchanged", () => {
    expect(cellToString(null)).toBe("");
    expect(cellToString(undefined)).toBe("");
    expect(cellToString("CARRETA")).toBe("CARRETA");
  });
});

describe("parseXlsxBytes — typed date cells", () => {
  it("stages a typed date cell as a zone-less ISO datetime string", async () => {
    const buf = await xlsxBuffer([
      ["trip_number", "eta"],
      ["LT1", ETA],
    ]);
    const records = await parseXlsxBytes(buf);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      rowNumber: 1,
      raw: { trip_number: "LT1", eta: "2026-06-07T15:00:00.000" },
    });
  });

  it("end-to-end: the staged value maps to the wall-clock interpreted in the template zone (15:00 → 18:00Z)", async () => {
    const buf = await xlsxBuffer([
      ["trip_number", "eta"],
      ["LT1", ETA],
    ]);
    const [record] = await parseXlsxBytes(buf);
    const template = templateConfigSchema.parse({
      customerId: "11111111-1111-1111-1111-111111111111",
      name: "Shopee-ish",
      version: 1,
      fileType: "xlsx",
      columnMappings: [
        { source: "trip_number", target: "externalTripId" },
        { source: "eta", target: "plannedPickupWindowStart" },
      ],
      // The operator's natural Brazilian format — the ISO fallback covers the typed-cell case.
      parsingRules: { dateFormats: ["dd/MM/yyyy HH:mm:ss"] },
    });
    const mapped = applyTemplate(record!.raw, template);
    expect(mapped.externalTripId).toBe("LT1");
    expect(mapped.plannedPickupWindowStart?.toISOString()).toBe("2026-06-07T18:00:00.000Z");
  });
});
