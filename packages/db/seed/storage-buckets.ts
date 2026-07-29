import "dotenv/config";
import {
  documentsBucket,
  ensureBucket,
  exportsBucket,
  importBucket,
} from "../src/storage";

/**
 * Feature 008 — provision the private Storage buckets (idempotent). Mirrors how `imports` is set up;
 * 008 adds `documents` + `billing-exports`. Run AFTER the Supabase stack is up (needs SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY):  pnpm --filter @brazil-tms/db db:seed:buckets
 */
async function main(): Promise<void> {
  for (const name of [importBucket(), documentsBucket(), exportsBucket()]) {
    await ensureBucket(name);
    console.log(`Ensured Storage bucket: ${name}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
