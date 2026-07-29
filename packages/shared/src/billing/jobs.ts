/**
 * Feature 008 — the on-demand billing-export job contract (data-model §9.3, R11). The job name +
 * typed payload are the SHARED contract the BFF (enqueue) and the worker (consume) agree on; the
 * worker-side pg-boss plumbing merges this into `workers/lib/queue.ts` (sibling of `import/jobs.ts`,
 * `sla/jobs.ts`). No pg-boss import here.
 */
export const BILLING_JOBS = {
  billingExport: "billing.export",
} as const;

export type BillingJobName = (typeof BILLING_JOBS)[keyof typeof BILLING_JOBS];

/** The export-batch row id + the actor whose authority marks the included trips Billed. */
export interface BillingExportPayload {
  exportBatchId: string;
  actorUserId: string;
}

export interface BillingJobPayloads {
  "billing.export": BillingExportPayload;
}
