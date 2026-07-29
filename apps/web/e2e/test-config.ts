/**
 * Shared test-environment bootstrap for Playwright specs.
 *
 * Seeded/known accounts are provided via environment variables so credentials
 * are never hard-coded. Populate these in `apps/web/.env.test` or the CI env.
 * See specs/001-platform-access-shell/quickstart.md for the manual flow.
 */

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required test env var: ${name}`);
  }
  return value;
}

export const testAccounts = {
  /** Seeded first Admin (must_change_password=true on first login). */
  admin: {
    email: env("E2E_ADMIN_EMAIL", "admin@braziltransports.com.br"),
    password: env("E2E_ADMIN_PASSWORD", "ChangeMe!Admin123"),
  },
  /** A non-admin account (e.g. Finance) used to assert role-gated denials. */
  nonAdmin: {
    email: env("E2E_NONADMIN_EMAIL", "finance@braziltransports.com.br"),
    password: env("E2E_NONADMIN_PASSWORD", "ChangeMe!Finance123"),
  },
  /** A dedicated account with must_change_password=true, for the forced-change flow (FR-013a). */
  tempPassword: {
    email: env("E2E_TEMPPW_EMAIL", "temppw@braziltransports.com.br"),
    password: env("E2E_TEMPPW_PASSWORD", "ChangeMe!Temp123"),
  },
  /** 002 master-data authorization (US5). Dispatcher = no master-data; Ops Mgr = commercial+fleet;
   *  Fleet Coord = fleet only (NOT commercial). */
  dispatcher: {
    email: env("E2E_DISPATCHER_EMAIL", "dispatcher@braziltransports.com.br"),
    password: env("E2E_DISPATCHER_PASSWORD", "ChangeMe!Dispatcher123"),
  },
  opsManager: {
    email: env("E2E_OPSMGR_EMAIL", "opsmanager@braziltransports.com.br"),
    password: env("E2E_OPSMGR_PASSWORD", "ChangeMe!Ops123"),
  },
  fleetCoord: {
    email: env("E2E_FLEETCOORD_EMAIL", "fleetcoord@braziltransports.com.br"),
    password: env("E2E_FLEETCOORD_PASSWORD", "ChangeMe!Fleet123"),
  },
} as const;

export const routes = {
  login: "/login",
  forgotPassword: "/forgot-password",
  setPassword: "/auth/set-password",
  home: "/",
  adminUsers: "/admin/users",
  adminAudit: "/admin/audit",
} as const;
