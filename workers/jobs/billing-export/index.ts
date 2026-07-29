import ExcelJS from "exceljs";
import { type PgBoss } from "pg-boss";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@brazil-tms/db/client";
import {
  billingItems,
  Conflict,
  customers,
  exportBatches,
  transitionTripStatus,
  trips,
} from "@brazil-tms/db";
import { exportStorageKey, putExport } from "@brazil-tms/db/storage";
import { type BillingExportPayload } from "@brazil-tms/shared";
import { JOB, work } from "../../lib/queue";

/**
 * Feature 008 — the on-demand `billing.export` worker job (data-model §12, R11). Off the request path:
 * set `running` → for each candidate `billing_ready` trip (customer+period) drive the guarded
 * `billing_ready → billed` transition (reused `transitionTripStatus`) AND link `export_batch_id`
 * ATOMICALLY in that transition's own transaction (the `txHook`) → build the file from the trips linked
 * to this batch → put to the `billing-exports` bucket → ONLY THEN set `file_storage_key`/`trip_count`/
 * `total_amount_cents`/`completed`. A throw sets the batch `failed` + `error_message` (durable status).
 *
 * FR-021 (never leave a trip half-transitioned, never complete with a non-billed trip; never strand or
 * double-bill). The single primitive that buys all of this is the ATOMIC bill+link: the
 * `export_batch_id` link is written INSIDE the same transaction as the optimistic `billing_ready →
 * billed` guard (`transitionTripStatus`'s `txHook`), so:
 *   - A trip is NEVER billed-but-unlinked (the two writes commit or roll back together) — no crash-window
 *     strand, even if the worker dies mid-loop.
 *   - Under two concurrent same-period batches, only the ONE transition that wins the
 *     `WHERE current_status = 'billing_ready'` guard links the trip; the loser raises `STALE_TRANSITION`,
 *     its `txHook` never runs, and it links nothing — so a trip is billed into EXACTLY one batch (no
 *     cross-link, no double-count).
 *
 * `export_batch_id` is therefore a PERMANENT "this trip was billed into this batch" record — the worker
 * never unlinks. The file/totals are the trips linked to this batch (`selectBatchRows`), a function of
 * that immutable link rather than the trip's live status, so a concurrent `billed → disputed` landing at
 * ANY point (including between the read and `completed`) cannot change the batch's membership: the export
 * is the historical record of what was billed, and a later dispute is a downstream credit handled by the
 * deferred dispute round-trip (003/later), not a retroactive edit to a completed export. Idempotent on
 * retry: already-`billed`+linked trips stay in the set (the candidate query only re-bills `billing_ready`).
 *
 * Until the exact finance format lands, the export uses the LABELED DEFAULT column set (§29 Input #4).
 */

interface ExportRow {
  tripId: string;
  externalTripId: string | null;
  customerName: string | null;
  billingPeriod: string;
  baseFreightCents: number | null;
  finalCents: number | null;
}

/** Per-trip computed final billable value (base freight + live adjustments, discount negated). */
const finalCentsSql = sql<string | null>`${billingItems.baseFreightCents} + COALESCE((
  SELECT SUM(CASE WHEN ba.type = 'discount' THEN -ba.amount_cents ELSE ba.amount_cents END)
  FROM billing_adjustments ba
  WHERE ba.billing_item_id = ${billingItems.id} AND ba.removed_at IS NULL
), 0)`;

async function setBatch(
  exportBatchId: string,
  patch: Partial<typeof exportBatches.$inferInsert>,
): Promise<void> {
  await db
    .update(exportBatches)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(exportBatches.id, exportBatchId));
}

/** The billing-ready trips for a customer+period — the candidates to bill into this batch. */
async function selectBillingReadyTripIds(
  customerId: string,
  billingPeriod: string,
): Promise<string[]> {
  const rows = await db
    .select({ tripId: trips.id })
    .from(trips)
    .innerJoin(billingItems, eq(billingItems.tripId, trips.id))
    .where(
      and(
        eq(trips.currentStatus, "billing_ready"),
        eq(trips.customerId, customerId),
        eq(billingItems.billingPeriod, billingPeriod),
      ),
    );
  return rows.map((r) => r.tripId);
}

/**
 * The export set: every trip LINKED to this batch (`billing_items.export_batch_id = batchId`). Because the
 * link is written atomically with the `billing_ready → billed` transition and never unlinked, "linked to
 * this batch" means exactly "was billed into this batch" — so the file/totals are a function of the
 * immutable link, NOT the trip's live status (a later `billed → disputed` does not change membership).
 */
async function selectBatchRows(exportBatchId: string): Promise<ExportRow[]> {
  const rows = await db
    .select({
      tripId: trips.id,
      externalTripId: trips.externalTripId,
      customerName: customers.name,
      billingPeriod: billingItems.billingPeriod,
      baseFreightCents: billingItems.baseFreightCents,
      finalCents: finalCentsSql,
    })
    .from(trips)
    .innerJoin(billingItems, eq(billingItems.tripId, trips.id))
    .leftJoin(customers, eq(trips.customerId, customers.id))
    .where(eq(billingItems.exportBatchId, exportBatchId));
  return rows.map((r) => ({
    tripId: r.tripId,
    externalTripId: r.externalTripId,
    customerName: r.customerName,
    billingPeriod: r.billingPeriod,
    baseFreightCents: r.baseFreightCents,
    finalCents: r.finalCents == null ? null : Number(r.finalCents),
  }));
}

/** Build the export file (labeled default columns) as bytes + the content type, per format. */
async function buildFile(
  rows: ExportRow[],
  format: string,
): Promise<{ bytes: Buffer; contentType: string; ext: string }> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Faturamento");
  sheet.columns = [
    { header: "ID Externo", key: "externalTripId", width: 24 },
    { header: "Cliente", key: "customerName", width: 30 },
    { header: "Período", key: "billingPeriod", width: 12 },
    { header: "Frete base (R$)", key: "base", width: 18 },
    { header: "Total a faturar (R$)", key: "final", width: 20 },
  ];
  for (const r of rows) {
    sheet.addRow({
      externalTripId: r.externalTripId ?? r.tripId,
      customerName: r.customerName ?? "",
      billingPeriod: r.billingPeriod,
      base: r.baseFreightCents != null ? r.baseFreightCents / 100 : "",
      final: r.finalCents != null ? r.finalCents / 100 : "",
    });
  }

  if (format === "csv") {
    const ab = await workbook.csv.writeBuffer();
    return { bytes: Buffer.from(ab as ArrayBuffer), contentType: "text/csv", ext: "csv" };
  }
  const ab = await workbook.xlsx.writeBuffer();
  return {
    bytes: Buffer.from(ab as ArrayBuffer),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: "xlsx",
  };
}

export async function runBillingExport(payload: BillingExportPayload): Promise<void> {
  const { exportBatchId, actorUserId } = payload;

  const batchRows = await db
    .select()
    .from(exportBatches)
    .where(eq(exportBatches.id, exportBatchId))
    .limit(1);
  const batch = batchRows[0];
  if (!batch) return; // nothing to export against

  try {
    await setBatch(exportBatchId, { status: "running" });

    // Bill each candidate billing-ready trip. The `export_batch_id` link is written INSIDE the guarded
    // transition's own transaction (the `txHook`), so bill + link commit or roll back together: a
    // crash/throw can never strand a trip billed-but-unlinked, and under concurrent same-period batches
    // only the transition that wins the optimistic guard links the trip (the loser's STALE rolls its
    // hook back), so each trip is billed into exactly one batch.
    const candidateIds = await selectBillingReadyTripIds(batch.customerId, batch.billingPeriod);
    for (const tripId of candidateIds) {
      try {
        await transitionTripStatus(
          tripId,
          { toStatus: "billed", expectedFromStatus: "billing_ready" },
          actorUserId,
          async (tx) => {
            await tx
              .update(billingItems)
              .set({ exportBatchId, updatedAt: new Date() })
              .where(eq(billingItems.tripId, tripId));
          },
        );
      } catch (err) {
        // The trip moved out of `billing_ready` (e.g. another actor disputed it, or another same-period
        // batch billed it first) between the candidate query and the transition. Its hook never ran, so
        // it is not linked to this batch — skip it; don't fail the whole batch.
        if (err instanceof Conflict && err.code === "STALE_TRANSITION") continue;
        throw err;
      }
    }

    // The file + totals are every trip linked to this batch (= billed into it). No reconcile/unlink: the
    // link is permanent, so membership is stable against any concurrent `billed → disputed`.
    const rows = await selectBatchRows(exportBatchId);

    const { bytes, contentType, ext } = await buildFile(rows, batch.format);
    const key = exportStorageKey(exportBatchId, ext);
    await putExport(key, bytes, contentType);

    const total = rows.reduce((sum, r) => sum + (r.finalCents ?? 0), 0);

    // Mark completed LAST — after every trip is atomically billed + linked and the file is durably put,
    // so a crash before this leaves the batch non-`completed` (retried) rather than wrongly authoritative.
    await setBatch(exportBatchId, {
      fileStorageKey: key,
      tripCount: rows.length,
      totalAmountCents: total,
      status: "completed",
    });
  } catch (err) {
    await setBatch(exportBatchId, {
      status: "failed",
      errorMessage: (err as Error).message.slice(0, 1000),
    });
    throw err; // let pg-boss record the failure (handlers are idempotent)
  }
}

export async function registerBillingExport(boss: PgBoss): Promise<void> {
  await work(boss, JOB.billingExport, async (payload) => {
    await runBillingExport(payload);
  });
}
