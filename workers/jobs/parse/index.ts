import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";
import type { PgBoss } from "pg-boss";
import { and, eq } from "drizzle-orm";
import {
  db,
  importBatches,
  importRows,
  importTemplates,
} from "@brazil-tms/db";
import { downloadObject } from "@brazil-tms/db/storage";
import {
  applyTemplate,
  inferFileType,
  STANDARD_IMPORT_TEMPLATE,
  templateConfigSchema,
  type ParsePayload,
  type TemplateConfig,
} from "@brazil-tms/shared";
import {
  setBatchFailed,
  setBatchStatus,
  setBatchTotalRows,
} from "../../lib/batch-progress";
import { JOB, enqueue, work } from "../../lib/queue";

/**
 * T030 — `import.parse` job (data-model lifecycle; contract §C; research R5/R6). Downloads the
 * original upload from Storage, parses it row-by-row with the template-declared format
 * (`csv-parse`/`exceljs`), maps each raw row to the internal trip shape via the SHARED engine
 * (`applyTemplate` — no per-customer code, Constitution V), and stages every row in `import_rows`.
 *
 * Row numbering: the file's header is NOT a data row. The FIRST data row is `row_number = 1`
 * (1-based over data rows) — preserved verbatim so the preview/error report can point the user back
 * at their source line.
 *
 * A mapping THROW (bad date/number/json) does not lose the row: we still stage it with `mapped: null`
 * and an `error` outcome + `MAPPING_ERROR` reason (the validate stage treats null `mapped` the same
 * way, but recording it here keeps the message close to the cause). A corrupt/wrong-type file (the
 * parser itself throws) is an unrecoverable batch failure → `failed` (original file retained).
 */

interface ParsedRecord {
  rowNumber: number;
  raw: Record<string, string>;
}

/** Build the validated `TemplateConfig` from the persisted template row. */
function toTemplateConfig(row: typeof importTemplates.$inferSelect): TemplateConfig {
  return templateConfigSchema.parse({
    customerId: row.customerId,
    name: row.name,
    version: row.version,
    fileType: row.fileType,
    columnMappings: row.columnMappings,
    parsingRules: row.parsingRules,
    requiredOverrides: row.requiredOverrides,
  });
}

/** CSV → records keyed by header, with 1-based data-row numbers (header excluded). */
function parseCsvBytes(bytes: Buffer): ParsedRecord[] {
  const rows = parseCsv(bytes, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    // Strip a leading UTF-8 BOM so the first header maps cleanly. Excel/Sheets exports (and the in-app
    // sample download) commonly prepend a BOM; without this the first column key becomes "\uFEFFid_viagem"
    // and the required external-id mapping silently misses → every row MISSING_EXTERNAL_ID.
    bom: true,
  }) as Record<string, string>[];
  return rows.map((raw, index) => ({ rowNumber: index + 1, raw }));
}

/** Stringify an ExcelJS cell value to the same string shape the engine expects from CSV. */
function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const obj = value as unknown as Record<string, unknown>;
    // ExcelJS rich-text / hyperlink / formula result shapes.
    if (typeof obj.text === "string") return obj.text;
    if ("result" in obj && obj.result != null) return String(obj.result);
    if (Array.isArray((obj as { richText?: unknown }).richText)) {
      return (obj as { richText: { text: string }[] }).richText.map((r) => r.text).join("");
    }
    if (typeof obj.hyperlink === "string") return obj.hyperlink;
  }
  return String(value);
}

/** XLSX → records from the first worksheet; row 1 = headers, data rows numbered 1-based. */
async function parseXlsxBytes(bytes: Buffer): Promise<ParsedRecord[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber] = cellToString(cell.value).trim();
  });

  const records: ParsedRecord[] = [];
  let dataRowNumber = 0;
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const raw: Record<string, string> = {};
    let hasValue = false;
    for (let c = 1; c < headers.length; c++) {
      const header = headers[c];
      if (!header) continue;
      const text = cellToString(row.getCell(c).value).trim();
      raw[header] = text;
      if (text !== "") hasValue = true;
    }
    if (!hasValue) continue; // skip blank rows (mirrors csv skip_empty_lines)
    dataRowNumber += 1;
    records.push({ rowNumber: dataRowNumber, raw });
  }
  return records;
}

export async function runParse(payload: ParsePayload): Promise<void> {
  const { batchId, storageKey } = payload;
  await setBatchStatus(batchId, "parsing");

  const batchRows = await db
    .select()
    .from(importBatches)
    .where(eq(importBatches.id, batchId))
    .limit(1);
  const batch = batchRows[0];
  if (!batch) {
    // Nothing to parse against; treat as an unrecoverable failure (no batch row).
    return;
  }

  // Resolve the mapping config. Slice 013: a batch with no template (the operator path) is mapped with
  // the in-code STANDARD_IMPORT_TEMPLATE — no batch fails for "no template" anymore. The templateId path
  // (the dormant per-customer API) is kept intact for when real signed-off configs arrive.
  let template: TemplateConfig;
  if (batch.templateId) {
    const templateRows = await db
      .select()
      .from(importTemplates)
      .where(eq(importTemplates.id, batch.templateId))
      .limit(1);
    const templateRow = templateRows[0];
    if (!templateRow) {
      await setBatchFailed(batchId, "Nenhum modelo de importação selecionado.");
      return;
    }
    try {
      template = toTemplateConfig(templateRow);
    } catch (err) {
      await setBatchFailed(
        batchId,
        `Configuração do modelo de importação inválida: ${(err as Error).message}`,
      );
      return;
    }
  } else {
    template = STANDARD_IMPORT_TEMPLATE;
  }

  // Choose CSV vs XLSX from the uploaded file's name extension (slice 013) — the single canonical rule
  // the BFF already applied at upload — not a stored template attribute. `null` should never reach here
  // (the BFF rejects unsupported types); fail defensively with the unreadable-file message if it does.
  const fileType = inferFileType(batch.fileName);
  if (!fileType) {
    await setBatchFailed(
      batchId,
      "Falha ao ler o arquivo de importação: tipo de arquivo não suportado (use .csv ou .xlsx).",
    );
    return;
  }

  // Download + parse the original file. A parser throw = corrupt/wrong-type file → batch failure.
  let records: ParsedRecord[];
  try {
    const bytes = await downloadObject(storageKey);
    records = fileType === "xlsx" ? await parseXlsxBytes(bytes) : parseCsvBytes(bytes);
  } catch (err) {
    await setBatchFailed(
      batchId,
      `Falha ao ler o arquivo de importação: ${(err as Error).message}`,
    );
    return;
  }

  // Idempotent re-parse (STACK §3.11): a crash/retry after partial staging must not collide with the
  // `(import_batch_id, row_number)` unique index. Clear any rows staged by a prior attempt first, so a
  // pg-boss retry re-stages this batch cleanly instead of failing on duplicate keys.
  await db.delete(importRows).where(eq(importRows.importBatchId, batchId));

  // Stage each row. A per-row mapping throw is recorded (not fatal): mapped null + MAPPING_ERROR.
  for (const { rowNumber, raw } of records) {
    let mapped: unknown = null;
    let outcome: "error" | null = null;
    let reasons: { code: string; field?: string; message: string }[] = [];
    try {
      mapped = applyTemplate(raw, template);
    } catch (err) {
      mapped = null;
      outcome = "error";
      reasons = [
        {
          code: "MAPPING_ERROR",
          message: `Falha ao interpretar a linha: ${(err as Error).message}`,
        },
      ];
    }

    await db.insert(importRows).values({
      importBatchId: batchId,
      rowNumber,
      raw,
      mapped: mapped as object | null,
      outcome,
      reasons,
    });
  }

  await setBatchTotalRows(batchId, records.length);
}

export async function registerParse(boss: PgBoss): Promise<void> {
  await work(boss, JOB.parse, async (payload) => {
    await runParse(payload);
    // Chain to validate UNLESS the batch failed (parse sets `failed` on unrecoverable errors).
    const rows = await db
      .select({ status: importBatches.status })
      .from(importBatches)
      .where(and(eq(importBatches.id, payload.batchId)))
      .limit(1);
    if (rows[0]?.status === "failed") return;
    await enqueue(boss, JOB.validate, { batchId: payload.batchId });
  });
}
