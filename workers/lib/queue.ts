import { PgBoss, type Job } from "pg-boss";
import {
  BILLING_JOBS,
  DOCUMENT_JOBS,
  IMPORT_JOBS,
  SLA_JOBS,
  type BillingJobName,
  type BillingJobPayloads,
  type DocumentJobName,
  type DocumentJobPayloads,
  type ImportJobName,
  type ImportJobPayloads,
  type SlaJobName,
  type SlaJobPayloads,
} from "@brazil-tms/shared";

/**
 * pg-boss queue surface for the single worker (features 004 + 007, research R1/R3/R10). One Node
 * worker, one Postgres-backed queue (no Redis/broker — STACK §3.11). Job names + typed payloads are
 * the shared contract in `@brazil-tms/shared`; this module adds the worker-side pg-boss plumbing.
 *
 * The import pipeline jobs chain on success (parse → validate → detect-duplicates → optional
 * generate-error-report; confirm is enqueued by the user). Feature 007 merges the SLA sweep job
 * (`sla.sweep`) — the first SCHEDULED (cron) job — into the same `JOB`/`JobName`/`JobPayloads`
 * surface and the bootstrap queue-creation loop.
 */

/**
 * The merged job-name → queue-name map (import pipeline + the 007 SLA sweep + the 008 on-demand
 * `billing.export` and the second scheduled job `documents.checks`).
 */
export const JOB = { ...IMPORT_JOBS, ...SLA_JOBS, ...BILLING_JOBS, ...DOCUMENT_JOBS } as const;

export type JobName = ImportJobName | SlaJobName | BillingJobName | DocumentJobName;
export type JobPayloads = ImportJobPayloads &
  SlaJobPayloads &
  BillingJobPayloads &
  DocumentJobPayloads;

/** Construct the pg-boss instance against the worker's DATABASE_URL (server/worker-only). */
export function createBoss(): PgBoss {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for the worker (pg-boss).");
  }
  return new PgBoss({ connectionString });
}

/** Create every queue (idempotent). Must run after `boss.start()` and before send/work/schedule. */
export async function setupQueues(boss: PgBoss): Promise<void> {
  for (const name of Object.values(JOB)) {
    await boss.createQueue(name);
  }
}

/** Typed enqueue helper — the only way the BFF/worker should publish a job. */
export async function enqueue<K extends JobName>(
  boss: PgBoss,
  name: K,
  data: JobPayloads[K],
): Promise<string | null> {
  return boss.send(name, data as object);
}

/**
 * Typed worker registration. pg-boss delivers a batch array; we unwrap and run the handler per job
 * so each stage stays a simple `(payload) => Promise<void>`. A throw makes pg-boss retry the job
 * (handlers are idempotent — STACK §3.11).
 */
export async function work<K extends JobName>(
  boss: PgBoss,
  name: K,
  handler: (data: JobPayloads[K]) => Promise<void>,
): Promise<void> {
  await boss.work<JobPayloads[K]>(name, async (jobs: Job<JobPayloads[K]>[]) => {
    for (const job of jobs) {
      await handler(job.data);
    }
  });
}
