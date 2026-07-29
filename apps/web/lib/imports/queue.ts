import "server-only";
import { type ImportJobName, type ImportJobPayloads } from "@brazil-tms/shared";
import { getBffBoss } from "@/lib/queue/boss";

/**
 * BFF-side enqueue for import-pipeline jobs (feature 004, research R3/R4). The upload + confirm
 * route handlers enqueue pg-boss jobs onto the same Postgres-backed queue the worker drains. We
 * delegate to the single shared, HMR-safe pg-boss sender (`lib/queue/boss.ts`) so the Next server
 * keeps exactly one pool. Heavy work stays in the worker; the BFF only validates, writes the batch
 * row, and enqueues. Job names + payload types come from `@brazil-tms/shared` so the BFF and worker
 * share one contract.
 */

/** Typed enqueue — the only way the BFF should publish an import job. */
export async function enqueueImportJob<K extends ImportJobName>(
  name: K,
  data: ImportJobPayloads[K],
): Promise<string | null> {
  const boss = await getBffBoss();
  return boss.send(name, data as object);
}
