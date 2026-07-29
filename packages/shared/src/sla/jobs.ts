/**
 * Feature 007 — the SLA worker-job contract (data-model §9.3, R10). Pure (no pg-boss import): the job
 * name + payload that the worker `lib/queue.ts` merges into its `JOB`/`JobName`/`JobPayloads` surface.
 * Sibling of `import/jobs.ts`. The BFF never enqueues this — it is a scheduled cron sweep (the first
 * ever in this codebase).
 */

export const SLA_JOBS = {
  slaSweep: "sla.sweep",
} as const;

export type SlaJobName = (typeof SLA_JOBS)[keyof typeof SLA_JOBS];

/** Scheduled cron has no per-run input. */
export type SlaSweepPayload = Record<string, never>;

export interface SlaJobPayloads {
  "sla.sweep": SlaSweepPayload;
}
