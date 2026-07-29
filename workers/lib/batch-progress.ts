import { db, importBatches } from "@brazil-tms/db";
import { eq } from "drizzle-orm";

/**
 * Durable batch progress (feature 004, research R3). The import pipeline reports status + the four
 * outcome counts to `import_batches` so the BFF can surface progress by TanStack Query polling (no
 * Realtime). Counts are mutable operational progress; the immutable trace is `import_rows.raw` + the
 * original file in Storage.
 */

export type ImportBatchStatus =
  | "received"
  | "parsing"
  | "validating"
  | "validated"
  | "confirming"
  | "completed"
  | "failed";

export interface ImportBatchCounts {
  totalRows?: number;
  createdCount?: number;
  updatedCount?: number;
  duplicateCount?: number;
  errorCount?: number;
}

export async function setBatchStatus(batchId: string, status: ImportBatchStatus): Promise<void> {
  await db
    .update(importBatches)
    .set({ status, updatedAt: new Date() })
    .where(eq(importBatches.id, batchId));
}

export async function setBatchTotalRows(batchId: string, totalRows: number): Promise<void> {
  await db
    .update(importBatches)
    .set({ totalRows, updatedAt: new Date() })
    .where(eq(importBatches.id, batchId));
}

/** Set absolute outcome counts (the detect-duplicates / confirm jobs compute the final tallies). */
export async function setBatchCounts(batchId: string, counts: ImportBatchCounts): Promise<void> {
  await db
    .update(importBatches)
    .set({ ...counts, updatedAt: new Date() })
    .where(eq(importBatches.id, batchId));
}

export async function setErrorReportKey(batchId: string, storageKey: string): Promise<void> {
  await db
    .update(importBatches)
    .set({ errorReportStorageKey: storageKey, updatedAt: new Date() })
    .where(eq(importBatches.id, batchId));
}

/** Unrecoverable failure: mark `failed` + record the message. The original file is retained. */
export async function setBatchFailed(batchId: string, errorMessage: string): Promise<void> {
  await db
    .update(importBatches)
    .set({ status: "failed", errorMessage, updatedAt: new Date() })
    .where(eq(importBatches.id, batchId));
}
