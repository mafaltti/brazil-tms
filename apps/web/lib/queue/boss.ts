import "server-only";
import { PgBoss } from "pg-boss";
import { BILLING_JOBS, IMPORT_JOBS } from "@brazil-tms/shared";

/**
 * ONE shared pg-boss SENDER for the whole Next (BFF) server process. The BFF only enqueues jobs
 * (the import pipeline + the on-demand billing export); the single worker drains them and owns
 * processing + maintenance + cron.
 *
 * Previously `lib/imports/queue.ts` and `lib/billing/queue.ts` each created their OWN PgBoss
 * instance (two pools), and each leaked a fresh pool on every Next dev HMR recompile because the
 * singleton was module-scoped with no `globalThis` cache — a contributor to "53300: sorry, too many
 * clients already". This consolidates both into one HMR-safe instance with a small pool (a sender
 * needs few connections) and creates every BFF queue on it (idempotent), so `send()` works even
 * before the worker boots.
 */
const globalForBoss = globalThis as unknown as { __btmsBffBoss?: Promise<PgBoss> };

/** The single shared, HMR-safe BFF pg-boss sender. */
export function getBffBoss(): Promise<PgBoss> {
  return (globalForBoss.__btmsBffBoss ??= (async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is required to enqueue jobs.");
    }
    // Sender-only role → a small pool is plenty; the worker owns job processing and maintenance.
    const boss = new PgBoss({ connectionString, max: 4 });
    boss.on("error", (err: Error) => console.error("[pg-boss/bff] error", err));
    await boss.start();
    // Ensure every queue the BFF sends to exists (idempotent) so send() works before the worker boots.
    for (const name of [...Object.values(IMPORT_JOBS), ...Object.values(BILLING_JOBS)]) {
      await boss.createQueue(name);
    }
    return boss;
  })());
}
