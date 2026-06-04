import type { PermissionKey } from "@brazil-tms/shared";

export interface NavItem {
  /** Key under the `Nav` i18n namespace (messages/pt-BR.json). */
  key: string;
  href: string;
  /** lucide-react icon name, resolved in the sidebar component. */
  icon: string;
  /** Required permission; `undefined` = visible to any authenticated user. */
  permission?: PermissionKey;
}

/**
 * Role-gated navigation. The sidebar filters items via `can(role, permission)`; hiding is
 * additive only — the BFF stays authoritative (FR-011). Operational areas (features 002–009)
 * are added here as those features land.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: "home", href: "/", icon: "LayoutDashboard" },
  // 005 — Control Tower board (view_all_trips: all 7 internal roles).
  { key: "trips", href: "/trips", icon: "Truck", permission: "view_all_trips" },
  // 006 — Dispatch Board (assign_resources: Admin, Ops Manager, Dispatcher, Fleet Coordinator).
  { key: "dispatch", href: "/dispatch", icon: "ClipboardCheck", permission: "assign_resources" },
  // 007 — Exception Management queue (view_all_trips: all 7 internal roles read) + per-customer SLA
  // rules admin (manage_commercial_data: Admin, Ops Manager).
  { key: "exceptions", href: "/exceptions", icon: "TriangleAlert", permission: "view_all_trips" },
  { key: "slaRules", href: "/sla-rules", icon: "Gauge", permission: "manage_commercial_data" },
  // 008 — Documents + Billing (view_all_trips: all 7 internal roles read) + Rates (edit_rates:
  // Admin, Finance).
  { key: "documents", href: "/documents", icon: "FileCheck", permission: "view_all_trips" },
  { key: "billing", href: "/billing", icon: "Receipt", permission: "view_all_trips" },
  { key: "rates", href: "/billing/rates", icon: "DollarSign", permission: "edit_rates" },
  // 009 — Reports (view_all_trips: all 7 internal roles, mirroring the 005 dashboard).
  { key: "reports", href: "/reports", icon: "BarChart3", permission: "view_all_trips" },
  { key: "adminUsers", href: "/admin/users", icon: "Users", permission: "manage_users" },
  { key: "adminAudit", href: "/admin/audit", icon: "ScrollText", permission: "view_audit_log" },
  // 002 — commercial master data (manage_commercial_data: Admin, Ops Manager).
  { key: "customers", href: "/admin/customers", icon: "Building2", permission: "manage_commercial_data" },
  { key: "locations", href: "/admin/locations", icon: "MapPin", permission: "manage_commercial_data" },
  { key: "lanes", href: "/admin/lanes", icon: "Route", permission: "manage_commercial_data" },
  // 008 — per-customer document-requirement checklists + the document-type master.
  {
    key: "documentRequirements",
    href: "/admin/document-requirements",
    icon: "ListChecks",
    permission: "manage_commercial_data",
  },
  // 004 — trip import (import_trips: Admin, Ops Manager).
  { key: "imports", href: "/imports", icon: "Upload", permission: "import_trips" },
  { key: "importHistory", href: "/imports/history", icon: "History", permission: "import_trips" },
  // 012 — import template administration (import_trips: Admin, Ops Manager).
  { key: "importTemplates", href: "/admin/import-templates", icon: "FileCog", permission: "import_trips" },
  // 002 — fleet master data (manage_fleet_data: Admin, Ops Manager, Fleet Coordinator).
  { key: "drivers", href: "/resources/drivers", icon: "UserRound", permission: "manage_fleet_data" },
  { key: "vehicles", href: "/resources/vehicles", icon: "Truck", permission: "manage_fleet_data" },
  { key: "trailers", href: "/resources/trailers", icon: "Container", permission: "manage_fleet_data" },
  { key: "carriers", href: "/resources/carriers", icon: "Factory", permission: "manage_fleet_data" },
];
