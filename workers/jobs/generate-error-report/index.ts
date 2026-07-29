import ExcelJS from "exceljs";
import type { PgBoss } from "pg-boss";
import { asc, eq } from "drizzle-orm";
import { db, importRows } from "@brazil-tms/db";
import { putErrorReport } from "@brazil-tms/db/storage";
import type { GenerateErrorReportPayload } from "@brazil-tms/shared";
import { setErrorReportKey } from "../../lib/batch-progress";
import { JOB, work } from "../../lib/queue";

/**
 * T041 — `import.generate-error-report` job (US2; data-model lifecycle; research R5/R12). Enqueued by
 * `detect-duplicates` ONLY when the batch has error rows. It writes a customer-facing XLSX listing the
 * failed rows — their original `row_number`, the joined reason `code`/`message` pairs, and a compact
 * dump of the row's `raw` cells — so the user can correct and re-import (FR-013). The report is an
 * immutable object in Supabase Storage (R12); only its key lives on `import_batches`.
 *
 * Building the workbook is pure-ish (exceljs in memory) and the upload + key write are the only side
 * effects, so a retry simply overwrites the same key (idempotent — STACK §3.11).
 */

interface Reason {
  code: string;
  field?: string;
  message: string;
}

/** Join a row's reasons into one cell each for codes and messages (multiple reasons per row). */
function joinReasons(reasons: Reason[]): { codes: string; messages: string } {
  return {
    codes: reasons.map((r) => r.code).join("; "),
    messages: reasons.map((r) => (r.field ? `${r.field}: ${r.message}` : r.message)).join("; "),
  };
}

/** Compact one-cell dump of the raw cells (`key=value` pairs) for the user to locate the source. */
function dumpRaw(raw: unknown): string {
  if (raw == null || typeof raw !== "object") return "";
  return Object.entries(raw as Record<string, unknown>)
    .map(([k, v]) => `${k}=${v == null ? "" : String(v)}`)
    .join(" | ");
}

export async function runGenerateErrorReport(payload: GenerateErrorReportPayload): Promise<void> {
  const { batchId } = payload;

  const errorRows = await db
    .select()
    .from(importRows)
    .where(eq(importRows.importBatchId, batchId))
    .orderBy(asc(importRows.rowNumber));

  const failed = errorRows.filter((r) => r.outcome === "error");

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Erros");
  sheet.columns = [
    { header: "Linha", key: "rowNumber", width: 10 },
    { header: "Códigos", key: "codes", width: 30 },
    { header: "Mensagens", key: "messages", width: 60 },
    { header: "Dados originais", key: "raw", width: 80 },
  ];

  for (const row of failed) {
    const reasons = Array.isArray(row.reasons) ? (row.reasons as Reason[]) : [];
    const { codes, messages } = joinReasons(reasons);
    sheet.addRow({
      rowNumber: row.rowNumber,
      codes,
      messages,
      raw: dumpRaw(row.raw),
    });
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  const buffer = Buffer.from(arrayBuffer as ArrayBuffer);

  const key = await putErrorReport(batchId, buffer);
  await setErrorReportKey(batchId, key);
}

export async function registerGenerateErrorReport(boss: PgBoss): Promise<void> {
  await work(boss, JOB.generateErrorReport, async (payload) => {
    await runGenerateErrorReport(payload);
  });
}
