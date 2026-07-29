import "dotenv/config";
import { createBoss, setupQueues } from "./lib/queue";
import { registerJobHandlers } from "./jobs";

/**
 * Import worker entrypoint (feature 004, research R3). Boots the single pg-boss instance: creates the
 * pgboss schema + queues, registers the import job handlers, and shuts down gracefully. This is the
 * sanctioned "one app + one worker" process — heavy parse/validate/dedup/confirm work runs here, never
 * in BFF request handlers (STACK §2/§6.3).
 */
async function main(): Promise<void> {
  const boss = createBoss();
  boss.on("error", (err: Error) => console.error("[pg-boss] error", err));

  await boss.start();
  await setupQueues(boss);
  await registerJobHandlers(boss);
  console.log("[worker] import worker started; queues ready.");

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`[worker] ${signal} received; stopping pg-boss...`);
    try {
      await boss.stop({ graceful: true });
    } catch (err) {
      console.error("[worker] error during shutdown", err);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[worker] fatal startup error", err);
  process.exit(1);
});
