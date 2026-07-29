import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { db, users } from "../src";

/**
 * Bootstrap the first Admin so the system can create everyone else (research §14).
 * Idempotent. Reads SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD (never hard-coded). Creates the GoTrue
 * auth user (email_confirm) + the public.users admin profile with must_change_password=true.
 *
 * Env: provide via shell or a packages/db/.env (see apps/web/.env.local.example for the values):
 *   SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, DATABASE_URL,
 *   (NEXT_PUBLIC_SUPABASE_URL | SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
 */
const ADMIN_NAME = "Administrador";

async function main(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!email || !password) {
    throw new Error("SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are required.");
  }
  if (!url || !serviceRoleKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are required.",
    );
  }

  const admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const existingProfile = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existingProfile[0]) {
    console.log(`Admin profile already exists for ${email}; nothing to do.`);
    return;
  }

  // Create (or recover) the GoTrue auth user.
  let authUserId: string | null = null;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name: ADMIN_NAME },
    app_metadata: { must_change_password: true },
  });
  if (data?.user) {
    authUserId = data.user.id;
  } else {
    // Likely already registered from a prior partial run — recover the id via paginated listUsers.
    console.warn(`createUser did not return a user (${error?.message ?? "?"}); looking it up.`);
    for (let page = 1; page <= 20 && !authUserId; page++) {
      const list = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (list.error) throw new Error(`listUsers failed: ${list.error.message}`);
      const match = list.data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
      if (match) authUserId = match.id;
      if (list.data.users.length < 200) break;
    }
  }
  if (!authUserId) {
    throw new Error(`Could not create or find the GoTrue auth user for ${email}.`);
  }

  await db.insert(users).values({
    id: authUserId,
    name: ADMIN_NAME,
    email,
    role: "admin",
    status: "active",
    mustChangePassword: true,
  });

  console.log(`Seeded first Admin: ${email} (must change password on first sign-in).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
