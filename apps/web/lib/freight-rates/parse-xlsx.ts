import "server-only";
import ExcelJS from "exceljs";
import { FREIGHT_SHEET_HEADER, FREIGHT_SHEET_NAME, normalizeText } from "@brazil-tms/shared";

/**
 * Feature 016 — XLSX buffer → raw cell grid for the shared normalizer (research R6).
 * Only the first 9 columns matter (FREIGHT_SHEET_HEADER); numeric cells stay numbers so
 * `parsePriceCents` sees them unformatted. Merged route cells are fine: exceljs propagates the
 * master value and the normalizer counts routes by distinct keys. Returns `null` when the
 * workbook has no "Controle de Fretes" worksheet.
 */

/** Mirrors the 004 worker's cell coercion (rich text / hyperlink / formula results). */
function cellToRaw(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const obj = value as unknown as Record<string, unknown>;
    if ("result" in obj && obj.result !== undefined) return cellToRaw(obj.result as ExcelJS.CellValue);
    if ("text" in obj && typeof obj.text === "string") return obj.text;
    if ("richText" in obj && Array.isArray(obj.richText)) {
      return (obj.richText as { text: string }[]).map((part) => part.text).join("");
    }
    if ("hyperlink" in obj && typeof obj.hyperlink === "string") return obj.hyperlink;
  }
  return String(value);
}

export async function parseFreightSheet(bytes: Buffer): Promise<unknown[][] | null> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheet =
    workbook.worksheets.find((ws) => normalizeText(ws.name) === normalizeText(FREIGHT_SHEET_NAME)) ??
    null;
  if (!sheet) return null;

  const grid: unknown[][] = [];
  for (let r = 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const cells: unknown[] = [];
    for (let c = 1; c <= FREIGHT_SHEET_HEADER.length; c++) {
      cells.push(cellToRaw(row.getCell(c).value));
    }
    grid.push(cells);
  }
  return grid;
}
