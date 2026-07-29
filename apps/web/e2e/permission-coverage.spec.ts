import { test, expect, type APIRequestContext } from "@playwright/test";
import { testAccounts } from "./test-config";

/**
 * Feature 009 US5 — permission-coverage hardening matrix (FR-016 / SC-004 / §23 row 12). For EVERY
 * operational/billing mutation endpoint across slices 001–008, a NON-HOLDER of the guarding key is
 * denied `403` and a HOLDER passes the permission gate (status ≠ 403). Authorization is enforced before
 * any parse/load/mutation in every route (`requireAuth → requirePermission → …`), so the non-holder
 * `403` is reached with FAKE ids and empty bodies and causes NO state change (SC-003) — no seeding
 * needed. The holder side asserts ≠ 403 (the request gets past the gate; a fake id then yields 400/404/
 * 409, never 403), proving the key opens the gate.
 *
 * Coverage notes (documented, not silently dropped):
 *  - `upload_documents` has no seeded non-holder (all seven internal roles except executive_viewer hold
 *    it; executive_viewer is not seeded), so its negative case can't be exercised here.
 *  - `resolve_dispute` is enforced CONDITIONALLY inside the status-transition handler (not a
 *    top-level `requirePermission`), so it's covered by the execution specs.
 *  - `cancel_trip` (017): enforced top-level at the DEDICATED endpoints (`/cancel`,
 *    `/cancellation-options`) — rows below; the generic `/status` route refuses `cancelled` outright
 *    (USE_CANCELLATION_ENDPOINT, covered in trip-cancellation.spec.ts).
 */

const FAKE = "00000000-0000-4000-8000-000000000000";

const ACCT = {
  admin: testAccounts.admin,
  finance: testAccounts.nonAdmin,
  dispatcher: testAccounts.dispatcher,
  opsManager: testAccounts.opsManager,
  fleetCoord: testAccounts.fleetCoord,
} as const;

type AcctKey = keyof typeof ACCT;
type Method = "POST" | "PATCH" | "DELETE" | "GET";

interface Case {
  key: string;
  name: string;
  method: Method;
  path: string;
  holder: AcctKey;
  nonHolder: AcctKey;
}

// One row per guarded mutation endpoint across 001–008 (per contracts/permission-matrix §B.1).
const CASES: Case[] = [
  // import_trips is held by admin + operations_manager only (NOT dispatcher — the nav comment misleads).
  { key: "import_trips", name: "create import batch", method: "POST", path: "/api/imports", holder: "opsManager", nonHolder: "finance" },
  { key: "import_trips", name: "confirm import", method: "POST", path: `/api/imports/${FAKE}/confirm`, holder: "opsManager", nonHolder: "finance" },
  { key: "import_trips", name: "create trip (manual)", method: "POST", path: "/api/trips", holder: "opsManager", nonHolder: "finance" },
  { key: "manage_trips", name: "edit trip plan", method: "PATCH", path: `/api/trips/${FAKE}/plan`, holder: "opsManager", nonHolder: "finance" },
  { key: "assign_resources", name: "assign resources", method: "POST", path: `/api/trips/${FAKE}/assignment`, holder: "dispatcher", nonHolder: "finance" },
  { key: "assign_resources", name: "confirm assignment", method: "POST", path: `/api/trips/${FAKE}/assignment/confirm`, holder: "dispatcher", nonHolder: "finance" },
  { key: "update_trip_status", name: "status transition", method: "POST", path: `/api/trips/${FAKE}/status`, holder: "dispatcher", nonHolder: "finance" },
  // 017 — cancel_trip: admin/ops_manager/dispatcher hold it; fleet_coordinator assigns but must NOT
  // cancel; finance must not even read the option lists.
  { key: "cancel_trip", name: "cancel trip", method: "POST", path: `/api/trips/${FAKE}/cancel`, holder: "dispatcher", nonHolder: "fleetCoord" },
  { key: "cancel_trip", name: "list cancellation options", method: "GET", path: "/api/cancellation-options", holder: "opsManager", nonHolder: "finance" },
  { key: "update_trip_status", name: "add trip event", method: "POST", path: `/api/trips/${FAKE}/events`, holder: "dispatcher", nonHolder: "finance" },
  { key: "create_exceptions", name: "create exception", method: "POST", path: `/api/trips/${FAKE}/exceptions`, holder: "dispatcher", nonHolder: "finance" },
  { key: "resolve_exceptions", name: "edit exception", method: "PATCH", path: `/api/exceptions/${FAKE}`, holder: "dispatcher", nonHolder: "finance" },
  { key: "resolve_exceptions", name: "transition exception", method: "POST", path: `/api/exceptions/${FAKE}/transition`, holder: "dispatcher", nonHolder: "finance" },
  { key: "verify_documents", name: "verify document", method: "PATCH", path: `/api/documents/${FAKE}`, holder: "finance", nonHolder: "dispatcher" },
  { key: "mark_completed", name: "mark completed", method: "POST", path: `/api/trips/${FAKE}/complete`, holder: "opsManager", nonHolder: "finance" },
  { key: "mark_billing_ready", name: "mark billing ready", method: "POST", path: `/api/trips/${FAKE}/billing-ready`, holder: "finance", nonHolder: "dispatcher" },
  { key: "edit_rates", name: "create rate", method: "POST", path: "/api/rates", holder: "finance", nonHolder: "dispatcher" },
  { key: "edit_rates", name: "edit rate", method: "PATCH", path: `/api/rates/${FAKE}`, holder: "finance", nonHolder: "dispatcher" },
  { key: "edit_rates", name: "edit billing item", method: "PATCH", path: `/api/trips/${FAKE}/billing`, holder: "finance", nonHolder: "dispatcher" },
  { key: "edit_rates", name: "add billing adjustment", method: "POST", path: `/api/trips/${FAKE}/billing/adjustments`, holder: "finance", nonHolder: "dispatcher" },
  { key: "edit_rates", name: "remove billing adjustment", method: "DELETE", path: `/api/billing-adjustments/${FAKE}`, holder: "finance", nonHolder: "dispatcher" },
  { key: "export_billing", name: "create export batch", method: "POST", path: "/api/billing/exports", holder: "finance", nonHolder: "dispatcher" },
  { key: "export_billing", name: "download export", method: "GET", path: `/api/billing/exports/${FAKE}/download`, holder: "finance", nonHolder: "dispatcher" },
  { key: "manage_commercial_data", name: "create customer", method: "POST", path: "/api/master-data/customers", holder: "opsManager", nonHolder: "dispatcher" },
  { key: "manage_commercial_data", name: "create document requirement", method: "POST", path: "/api/document-requirements", holder: "opsManager", nonHolder: "dispatcher" },
  { key: "manage_commercial_data", name: "create SLA rule", method: "POST", path: "/api/customer-sla-rules", holder: "opsManager", nonHolder: "dispatcher" },
  { key: "manage_fleet_data", name: "create driver", method: "POST", path: "/api/master-data/drivers", holder: "fleetCoord", nonHolder: "dispatcher" },
  { key: "manage_fleet_data", name: "create vehicle", method: "POST", path: "/api/master-data/vehicles", holder: "fleetCoord", nonHolder: "dispatcher" },
  { key: "delete_archive", name: "archive customer", method: "DELETE", path: `/api/master-data/customers/${FAKE}`, holder: "admin", nonHolder: "dispatcher" },
  { key: "manage_users", name: "create user", method: "POST", path: "/api/admin/users", holder: "admin", nonHolder: "finance" },
  { key: "manage_users", name: "update user", method: "PATCH", path: `/api/admin/users/${FAKE}`, holder: "admin", nonHolder: "finance" },
];

async function apiLogin(request: APIRequestContext, account: { email: string; password: string }) {
  const res = await request.post("/api/auth/sign-in", {
    data: { email: account.email, password: account.password },
  });
  expect(res.ok(), "sign-in must succeed").toBeTruthy();
}

function call(request: APIRequestContext, c: Case) {
  switch (c.method) {
    case "POST":
      return request.post(c.path, { data: {} });
    case "PATCH":
      return request.patch(c.path, { data: {} });
    case "DELETE":
      return request.delete(c.path);
    case "GET":
      return request.get(c.path);
  }
}

test.describe("US5 — permission coverage (every 001–008 mutation enforces its key)", () => {
  for (const c of CASES) {
    test(`${c.key} · ${c.name}: non-holder 403, holder passes the gate`, async ({ request }) => {
      // Non-holder → 403 (authz precedes any state change → SC-003).
      await apiLogin(request, ACCT[c.nonHolder]);
      const denied = await call(request, c);
      expect(denied.status(), `${c.nonHolder} should be denied for ${c.key}`).toBe(403);

      // Holder → past the gate (≠ 403; a fake id then yields 400/404/409).
      await apiLogin(request, ACCT[c.holder]);
      const allowed = await call(request, c);
      expect(allowed.status(), `${c.holder} should pass the gate for ${c.key}`).not.toBe(403);
    });
  }
});
