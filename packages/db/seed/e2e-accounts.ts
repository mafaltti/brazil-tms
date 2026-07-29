import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { appRole, db, users } from "../src";

/**
 * Provision the accounts the Playwright e2e suite expects (apps/web/e2e/test-config defaults).
 * Idempotent: ensure the GoTrue user (create or update password), then upsert the public.users
 * profile with the desired role/status/must_change_password. Run AFTER `db:migrate`:
 *   pnpm --filter @brazil-tms/db db:seed:e2e
 * Env (packages/db/.env or the shell): DATABASE_URL, (NEXT_PUBLIC_SUPABASE_URL | SUPABASE_URL),
 * SUPABASE_SERVICE_ROLE_KEY.
 */
type AppRole = (typeof appRole.enumValues)[number];
type Status = "pending" | "active" | "disabled";

interface SeedAccount {
  email: string;
  password: string;
  name: string;
  role: AppRole;
  status: Status;
  mustChange: boolean;
}

const ACCOUNTS: readonly SeedAccount[] = [
  { email: "admin@braziltransports.com.br", password: "ChangeMe!Admin123", name: "Administrador", role: "admin", status: "active", mustChange: false },
  { email: "finance@braziltransports.com.br", password: "ChangeMe!Finance123", name: "Financeiro Teste", role: "finance", status: "active", mustChange: false },
  { email: "temppw@braziltransports.com.br", password: "ChangeMe!Temp123", name: "Temp Teste", role: "dispatcher", status: "active", mustChange: true },
  { email: "disabled@braziltransports.com.br", password: "ChangeMe!Disabled123", name: "Desativado Teste", role: "dispatcher", status: "disabled", mustChange: false },
  // 002 master-data authorization (US5): a clean active Dispatcher (no master-data access), an
  // Operations Manager (commercial + fleet), and a Fleet Coordinator (fleet only, NOT commercial).
  { email: "dispatcher@braziltransports.com.br", password: "ChangeMe!Dispatcher123", name: "Despachante Teste", role: "dispatcher", status: "active", mustChange: false },
  { email: "opsmanager@braziltransports.com.br", password: "ChangeMe!Ops123", name: "Gerente Ops Teste", role: "operations_manager", status: "active", mustChange: false },
  { email: "fleetcoord@braziltransports.com.br", password: "ChangeMe!Fleet123", name: "Coord Frota Teste", role: "fleet_coordinator", status: "active", mustChange: false },
];

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are required.");
}
const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function ensureAuthUser(email: string, password: string): Promise<string> {
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.data?.user) return created.data.user.id;
  for (let page = 1; page <= 20; page++) {
    const list = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (list.error) throw new Error(`listUsers failed: ${list.error.message}`);
    const match = list.data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (match) {
      await admin.auth.admin.updateUserById(match.id, {
        password,
        email_confirm: true,
        ban_duration: "none",
      });
      return match.id;
    }
    if (list.data.users.length < 200) break;
  }
  throw new Error(`Could not create or find the GoTrue user for ${email}: ${created.error?.message ?? "?"}`);
}

async function main(): Promise<void> {
  for (const account of ACCOUNTS) {
    const id = await ensureAuthUser(account.email, account.password);
    const values = {
      name: account.name,
      email: account.email,
      role: account.role,
      status: account.status,
      mustChangePassword: account.mustChange,
    };
    const existing = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (existing[0]) {
      await db.update(users).set({ ...values, updatedAt: new Date() }).where(eq(users.id, id));
    } else {
      await db.insert(users).values({ id, ...values });
    }
    console.log(`ok: ${account.email} ${account.role} ${account.status} mustChange=${account.mustChange}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
