import { and, count, eq } from "drizzle-orm";
import { db } from "../client";
import { billingItems, exportBatches, trips } from "../../schema";
import type { CreateExportInput } from "@brazil-tms/shared";
import { writeAudit } from "../audit/write-audit";
import { Conflict } from "../errors";

/**
 * Feature 008 — export-batch creation (data-model §11, US5). The BFF calls this to validate a
 * non-empty billing-ready set for the customer+period, insert a durable `export_batches` row
 * (`queued`) + a `billing.export` audit, and return it; the ROUTE then enqueues the on-demand
 * `billing.export` worker job (the db package stays free of the web queue client — R11).
 */

export type ExportBatchInsert = typeof exportBatches.$inferSelect;

/** How many billing-ready trips fall in (customer, period) — the set the export will include. */
export async function countBillableTrips(customerId: string, billingPeriod: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(trips)
    .innerJoin(billingItems, eq(billingItems.tripId, trips.id))
    .where(
      and(
        eq(trips.currentStatus, "billing_ready"),
        eq(trips.customerId, customerId),
        eq(billingItems.billingPeriod, billingPeriod),
      ),
    );
  return rows[0]?.value ?? 0;
}

/** The export batch's file storage key + status (for the gated signed-URL download). */
export async function getExportDownload(
  exportBatchId: string,
): Promise<{ fileStorageKey: string | null; status: string } | null> {
  const rows = await db
    .select({ fileStorageKey: exportBatches.fileStorageKey, status: exportBatches.status })
    .from(exportBatches)
    .where(eq(exportBatches.id, exportBatchId))
    .limit(1);
  return rows[0] ?? null;
}

/** Validate + insert a queued export batch (+ audit). Throws `NO_BILLABLE_TRIPS` when the set is empty. */
export async function createExportBatch(
  input: CreateExportInput,
  actorUserId: string,
): Promise<ExportBatchInsert> {
  const n = await countBillableTrips(input.customerId, input.billingPeriod);
  if (n === 0) {
    throw new Conflict("NO_BILLABLE_TRIPS", "Nenhuma viagem pronta para faturar neste período.");
  }

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(exportBatches)
      .values({
        customerId: input.customerId,
        billingPeriod: input.billingPeriod,
        format: input.format,
        generatedByUserId: actorUserId,
        status: "queued",
      })
      .returning();
    await writeAudit(tx, {
      entityType: "export_batch",
      entityId: inserted[0]!.id,
      action: "billing.export",
      previousValue: null,
      newValue: {
        customerId: input.customerId,
        billingPeriod: input.billingPeriod,
        format: input.format,
      },
      actorUserId,
    });
    return inserted[0]!;
  });
}
