import "server-only";
import { BILLING_JOBS, type BillingJobName, type BillingJobPayloads } from "@brazil-tms/shared";
import { getBffBoss } from "@/lib/queue/boss";

/**
 * Feature 008 — BFF-side enqueue for the on-demand `billing.export` job (R11). The export route
 * validates + writes the `export_batches` row + enqueues; the worker drains the same Postgres-backed
 * queue and does the heavy ExcelJS generation off the request path. Delegates to the single shared,
 * HMR-safe pg-boss sender (`lib/queue/boss.ts`) so the Next server keeps exactly one pool.
 */

/** Typed enqueue — the only way the BFF should publish a billing job. */
export async function enqueueBillingJob<K extends BillingJobName>(
  name: K,
  data: BillingJobPayloads[K],
): Promise<string | null> {
  const boss = await getBffBoss();
  return boss.send(name, data as object);
}

/** Convenience: enqueue a billing-export run for an export batch. */
export async function enqueueBillingExport(payload: BillingJobPayloads["billing.export"]): Promise<string | null> {
  return enqueueBillingJob(BILLING_JOBS.billingExport, payload);
}
