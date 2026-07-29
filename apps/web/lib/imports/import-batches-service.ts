import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  Conflict,
  customers,
  db,
  importBatchStatus,
  importBatches,
  importTemplates,
  writeAudit,
} from "@brazil-tms/db";
import { IMPORT_JOBS, uploadMetaSchema } from "@brazil-tms/shared";
import { putOriginal, signedUrl } from "@/lib/supabase/storage";
import { enqueueImportJob } from "@/lib/imports/queue";

/**
 * Import-batch BFF service (feature 004, T028/T034). The fast upload path: validate metadata, assert
 * the target customer is active, put the original file in Storage, insert the `import_batches` row
 * (`status='received'`), audit `import.create`, and enqueue the `parse` job (R4). The heavy work
 * (parse/validate/dedup/confirm) runs in the worker; this file only reads progress (polled by the UI
 * via TanStack Query, no Realtime) and enqueues confirm. It never redefines the trip domain (003).
 */

/** Batch row shape returned by Drizzle selects (subset we map to DTOs). */
interface ImportBatchRow {
  id: string;
  customerId: string;
  templateId: string | null;
  fileName: string;
  storageKey: string;
  uploadedBy: string;
  status: string;
  totalRows: number;
  createdCount: number;
  updatedCount: number;
  duplicateCount: number;
  errorCount: number;
  errorReportStorageKey: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** List/history row (contract: bff-endpoints.md `ImportBatchSummary`; timestamps ISO UTC). */
export interface ImportBatchSummary {
  id: string;
  customerId: string;
  fileName: string;
  status: string;
  totalRows: number;
  createdCount: number;
  updatedCount: number;
  duplicateCount: number;
  errorCount: number;
  uploadedBy: string;
  createdAt: string;
  /** True once the error report exists in Storage (downloadable) — drives the "Baixar erros" affordance. */
  hasErrorReport: boolean;
}

/** Polled progress shape (contract: bff-endpoints.md `ImportBatchDetail`). */
export interface ImportBatchDetail extends ImportBatchSummary {
  templateId: string | null;
  errorMessage: string | null;
  updatedAt: string;
}

function toSummary(row: ImportBatchRow): ImportBatchSummary {
  return {
    id: row.id,
    customerId: row.customerId,
    fileName: row.fileName,
    status: row.status,
    totalRows: row.totalRows,
    createdCount: row.createdCount,
    updatedCount: row.updatedCount,
    duplicateCount: row.duplicateCount,
    errorCount: row.errorCount,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt.toISOString(),
    // A report only exists after generate-error-report has run; gate the download UI on this, not on
    // error_count (which is set earlier, while the report may still be generating or absent).
    hasErrorReport: row.errorReportStorageKey !== null,
  };
}

function toDetail(row: ImportBatchRow): ImportBatchDetail {
  return {
    ...toSummary(row),
    templateId: row.templateId,
    errorMessage: row.errorMessage,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Statuses from which a confirm can be (re-)issued — preview is ready (R8 confirm is idempotent). */
const CONFIRMABLE_STATUSES = new Set(["validated", "completed"]);

export interface CreateBatchInput {
  customerId: string;
  templateId?: string;
  fileName: string;
  fileType: "csv" | "xlsx";
  fileBytes: Buffer;
}

/**
 * The fast BFF upload path (R4). Validates metadata, asserts the customer is active, uploads the
 * ORIGINAL file to Storage, inserts the batch + `import.create` audit in one tx, then (after commit)
 * enqueues the `parse` job. Returns the new batch id immediately (the route responds `202`).
 */
export async function createBatch(
  input: CreateBatchInput,
  actorUserId: string,
): Promise<{ id: string }> {
  const { customerId, templateId, fileName, fileType } = uploadMetaSchema.parse({
    customerId: input.customerId,
    templateId: input.templateId,
    fileName: input.fileName,
    fileType: input.fileType,
  });

  const customerRows = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.id, customerId), isNull(customers.archivedAt)))
    .limit(1);
  if (!customerRows[0]) {
    throw new Conflict("INVALID_CUSTOMER", "Cliente inválido ou arquivado.");
  }

  // Validate the selected template up-front (don't let a stale/cross-customer/wrong-type template
  // reach the worker and fail the batch after we've already returned 202). The template must belong
  // to this customer, be active + not archived, and parse the uploaded file type.
  if (templateId) {
    const tpl = (
      await db
        .select({
          customerId: importTemplates.customerId,
          active: importTemplates.active,
          archivedAt: importTemplates.archivedAt,
          fileType: importTemplates.fileType,
        })
        .from(importTemplates)
        .where(eq(importTemplates.id, templateId))
        .limit(1)
    )[0];
    if (
      !tpl ||
      tpl.customerId !== customerId ||
      !tpl.active ||
      tpl.archivedAt !== null ||
      tpl.fileType !== fileType
    ) {
      throw new Conflict(
        "INVALID_TEMPLATE",
        "Modelo de importação inválido para este cliente/arquivo (inexistente, inativo, arquivado, de outro cliente ou de outro tipo de arquivo).",
      );
    }
  }

  const id = crypto.randomUUID();
  const storageKey = await putOriginal(
    id,
    input.fileBytes,
    fileType === "csv"
      ? "text/csv"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );

  await db.transaction(async (tx) => {
    await tx.insert(importBatches).values({
      id,
      customerId,
      templateId: templateId ?? null,
      fileName,
      storageKey,
      uploadedBy: actorUserId,
      status: "received",
    });
    await writeAudit(tx, {
      entityType: "import_batch",
      entityId: id,
      action: "import.create",
      previousValue: null,
      newValue: { fileName, customerId },
      actorUserId,
    });
  });

  // Enqueue only after the batch row is durably committed so the worker never races a missing row.
  await enqueueImportJob(IMPORT_JOBS.parse, { batchId: id, storageKey });

  return { id };
}

/** Polled progress endpoint (GET /api/imports/{id}). Returns null when the batch does not exist. */
export async function getBatch(batchId: string): Promise<ImportBatchDetail | null> {
  const rows = await db
    .select()
    .from(importBatches)
    .where(eq(importBatches.id, batchId))
    .limit(1);
  const row = rows[0];
  return row ? toDetail(row) : null;
}

export interface ListBatchesOptions {
  customerId?: string;
  status?: string;
  limit?: number;
}

/** Batch history (GET /api/imports), newest first (INT-004). Default limit 50. */
export async function listBatches(opts: ListBatchesOptions = {}): Promise<ImportBatchSummary[]> {
  const filters = [];
  if (opts.customerId) filters.push(eq(importBatches.customerId, opts.customerId));
  if (
    opts.status &&
    (importBatchStatus.enumValues as readonly string[]).includes(opts.status)
  ) {
    filters.push(
      eq(importBatches.status, opts.status as (typeof importBatchStatus.enumValues)[number]),
    );
  }
  const rows = await db
    .select()
    .from(importBatches)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(importBatches.createdAt))
    .limit(opts.limit ?? 50);
  return rows.map(toSummary);
}

/**
 * Enqueue confirmation for a batch (POST /api/imports/{id}/confirm). Marks the batch `confirming` and
 * audits `import.confirm`, then enqueues the `confirm` job (which applies valid+warning rows in the
 * worker, idempotently — R8). Throws `NOT_FOUND` when missing, `NOT_CONFIRMABLE` unless the preview is
 * ready (`validated`/`completed`).
 */
export async function confirmBatch(
  batchId: string,
  actorUserId: string,
): Promise<{ id: string }> {
  const rows = await db
    .select()
    .from(importBatches)
    .where(eq(importBatches.id, batchId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Conflict("NOT_FOUND", "Lote não encontrado.");
  if (!CONFIRMABLE_STATUSES.has(row.status)) {
    throw new Conflict(
      "NOT_CONFIRMABLE",
      "O lote não está pronto para confirmação.",
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .update(importBatches)
      .set({ status: "confirming", updatedAt: new Date() })
      .where(eq(importBatches.id, batchId));
    await writeAudit(tx, {
      entityType: "import_batch",
      entityId: batchId,
      action: "import.confirm",
      previousValue: { status: row.status },
      newValue: { status: "confirming" },
      actorUserId,
    });
  });

  await enqueueImportJob(IMPORT_JOBS.confirm, { batchId, actorUserId });

  return { id: batchId };
}

/**
 * Short-lived signed download URL for a batch's generated error report (used by US2's error-report
 * route). Returns null when the batch has no error report. Server-mediated only (no public URL, R12).
 */
export async function errorReportUrl(batchId: string): Promise<string | null> {
  const rows = await db
    .select({ key: importBatches.errorReportStorageKey })
    .from(importBatches)
    .where(eq(importBatches.id, batchId))
    .limit(1);
  const key = rows[0]?.key;
  if (!key) return null;
  return signedUrl(key, 300);
}
