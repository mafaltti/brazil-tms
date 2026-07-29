import "server-only";
import { PgBoss } from "pg-boss";
import { BILLING_JOBS, IMPORT_JOBS } from "@brazil-tms/shared";

/**
 * ONE shared pg-boss SENDER for the whole Next (BFF) server process. The BFF only enqueues jobs
 * (the import pipeline + the on-demand billing export); the single worker drains them and owns job
 * processing, cron/scheduling, and maintenance.
 *
 * Previously `lib/imports/queue.ts` and `lib/billing/queue.ts` each created their OWN PgBoss
 * instance (two pools), and each leaked a fresh pool on every Next dev HMR recompile because the
 * singleton was module-scoped with no `globalThis` cache — a contributor to "53300: sorry, too many
 * clients already". This consolidates both into one HMR-safe instance with a small pool (a sender
 * needs few connections) and creates every BFF queue on it (idempotent), so `send()` works even
 * before the worker boots.
 */
const globalForBoss = globalThis as unknown as { __btmsBffBoss?: Promise<PgBoss> };

async function startBffBoss(): Promise<PgBoss> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to enqueue jobs.");
  }
  // Sender-only: a small pool is plenty, and the BFF must NOT run pg-boss's cron/scheduling
  // (`schedule`) or maintenance (`supervise`) background workers — the single worker owns both.
  // Leaving `schedule` on would make the BFF's scheduler compete with the worker's to fire
  // `sla.sweep`/`documents.checks`; leaving `supervise` on adds redundant background connections.
  const boss = new PgBoss({ connectionString, max: 4, schedule: false, supervise: false });
  boss.on("error", (err: Error) => console.error("[pg-boss/bff] error", err));
  try {
    await boss.start();
    // Ensure every queue the BFF sends to exists (idempotent) so send() works before the worker boots.
    for (const name of [...Object.values(IMPORT_JOBS), ...Object.values(BILLING_JOBS)]) {
      await boss.createQueue(name);
    }
    return boss;
  } catch (err) {
    // Stop a partially-started instance so its pool/timers don't leak. The getBffBoss wrapper evicts
    // the rejected promise from the cache (below) so a later call retries instead of failing forever.
    await boss.stop({ graceful: false }).catch(() => {});
    throw err;
  }
}

/** The single shared, HMR-safe BFF pg-boss sender. */
export function getBffBoss(): Promise<PgBoss> {
  const existing = globalForBoss.__btmsBffBoss;
  if (existing) return existing;
  const pending = startBffBoss();
  globalForBoss.__btmsBffBoss = pending;
  // Never leave a REJECTED promise cached (every future enqueue would fail until process restart):
  // evict it once it settles to a rejection — unless a newer attempt has already replaced it.
  pending.catch(() => {
    if (globalForBoss.__btmsBffBoss === pending) {
      globalForBoss.__btmsBffBoss = undefined;
    }
  });
  return pending;
}
