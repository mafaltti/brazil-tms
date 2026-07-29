/**
 * Static role -> permission catalog (contracts/permission-matrix.md, PRD §18).
 * The single source of truth for authorization, consumed by both the BFF (`requireAuth` + `can`)
 * and the app-shell nav. No DB permissions table (FR-008, Constitution V). Feature 001 *enforces*
 * only `manage_users` and `view_audit_log`; the rest are declared now so features 002–009 add
 * enforcement points without editing this catalog (FR-010).
 */

export const Role = {
  Admin: "admin",
  OperationsManager: "operations_manager",
  Dispatcher: "dispatcher",
  ControlTower: "control_tower",
  FleetCoordinator: "fleet_coordinator",
  Finance: "finance",
  ExecutiveViewer: "executive_viewer",
} as const;

export type Role = (typeof Role)[keyof typeof Role];

/** The 7 assignable MVP roles. `customer_viewer` is a reserved DB enum value, NOT a Role (FR-007). */
export const ASSIGNABLE_ROLES: readonly Role[] = Object.values(Role);

export type PermissionKey =
  // enforced in 001:
  | "manage_users"
  | "view_audit_log"
  // declared now, enforced by later features (002–009):
  | "view_all_trips"
  | "import_trips"
  | "edit_trip_plan"
  | "assign_resources"
  | "update_trip_status"
  | "cancel_trip"
  | "mark_completed"
  | "mark_billing_ready"
  | "resolve_dispute"
  | "delete_archive"
  | "create_exceptions"
  | "resolve_exceptions"
  | "upload_documents"
  | "verify_documents"
  | "edit_rates"
  | "export_billing"
  // added by 002 (master data): create/edit/read commercial vs fleet entities (permission-matrix.md):
  | "manage_commercial_data"
  | "manage_fleet_data"
  // added by 003 (trip domain): create/transition/plan-update/cancel trips + read trip inspector:
  | "manage_trips"
  // added by 016 (freight rate lookup): internal agregados rate table — view for the 7 internal
  // roles, replace-by-upload mirrors the "edit_rates" precedent (Admin + Finance):
  | "view_freight_rates"
  | "import_freight_rates";

export const ALL_PERMISSIONS: readonly PermissionKey[] = [
  "manage_users",
  "view_audit_log",
  "view_all_trips",
  "import_trips",
  "edit_trip_plan",
  "assign_resources",
  "update_trip_status",
  "cancel_trip",
  "mark_completed",
  "mark_billing_ready",
  "resolve_dispute",
  "delete_archive",
  "create_exceptions",
  "resolve_exceptions",
  "upload_documents",
  "verify_documents",
  "edit_rates",
  "export_billing",
  "manage_commercial_data",
  "manage_fleet_data",
  "manage_trips",
  "view_freight_rates",
  "import_freight_rates",
];

// Admin is a superset of every permission (matrix invariant).
const ADMIN_PERMISSIONS = new Set<PermissionKey>(ALL_PERMISSIONS);

/** role -> granted permissions (✓ and ◐ both count as granted; see permission-matrix.md). */
export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<PermissionKey>> = {
  admin: ADMIN_PERMISSIONS,
  operations_manager: new Set<PermissionKey>([
    "view_all_trips",
    "import_trips",
    "edit_trip_plan",
    "assign_resources",
    "update_trip_status",
    "cancel_trip",
    "mark_completed",
    "resolve_dispute",
    "create_exceptions",
    "resolve_exceptions",
    "upload_documents",
    "verify_documents",
    "manage_commercial_data",
    "manage_fleet_data",
    "manage_trips",
    "view_freight_rates",
  ]),
  dispatcher: new Set<PermissionKey>([
    "view_all_trips",
    "edit_trip_plan",
    "assign_resources",
    "update_trip_status",
    "cancel_trip",
    "create_exceptions",
    "resolve_exceptions",
    "upload_documents",
    "view_freight_rates",
  ]),
  control_tower: new Set<PermissionKey>([
    "view_all_trips",
    "edit_trip_plan",
    "update_trip_status",
    "mark_completed",
    "create_exceptions",
    "resolve_exceptions",
    "upload_documents",
    "view_freight_rates",
  ]),
  fleet_coordinator: new Set<PermissionKey>([
    "view_all_trips",
    "assign_resources",
    "create_exceptions",
    "resolve_exceptions",
    "upload_documents",
    "manage_fleet_data",
    "view_freight_rates",
  ]),
  finance: new Set<PermissionKey>([
    "view_all_trips",
    "mark_billing_ready",
    "resolve_dispute",
    "upload_documents",
    "verify_documents",
    "edit_rates",
    "export_billing",
    "view_freight_rates",
    "import_freight_rates",
  ]),
  executive_viewer: new Set<PermissionKey>(["view_all_trips", "view_freight_rates"]),
};

/** Pure permission check. Returns false for any unknown role. */
export function can(role: Role, permission: PermissionKey): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}
