import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  ASSIGNABLE_ROLES,
  can,
  Role,
  type PermissionKey,
  type Role as RoleType,
} from "./permissions";

/**
 * Expected grants, transcribed independently from contracts/permission-matrix.md (PRD §18).
 * ✓ and ◐ both count as granted. This is the source of truth the catalog must match.
 */
const EXPECTED: Record<RoleType, PermissionKey[]> = {
  admin: [...ALL_PERMISSIONS], // superset
  operations_manager: [
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
  ],
  dispatcher: [
    "view_all_trips",
    "edit_trip_plan",
    "assign_resources",
    "update_trip_status",
    "cancel_trip",
    "create_exceptions",
    "resolve_exceptions",
    "upload_documents",
    "view_freight_rates",
  ],
  control_tower: [
    "view_all_trips",
    "edit_trip_plan",
    "update_trip_status",
    "mark_completed",
    "create_exceptions",
    "resolve_exceptions",
    "upload_documents",
    "view_freight_rates",
  ],
  fleet_coordinator: [
    "view_all_trips",
    "assign_resources",
    "create_exceptions",
    "resolve_exceptions",
    "upload_documents",
    "manage_fleet_data",
    "view_freight_rates",
  ],
  finance: [
    "view_all_trips",
    "mark_billing_ready",
    "resolve_dispute",
    "upload_documents",
    "verify_documents",
    "edit_rates",
    "export_billing",
    "view_freight_rates",
    "import_freight_rates",
  ],
  executive_viewer: ["view_all_trips", "view_freight_rates"],
};

const ALL_ROLES = Object.values(Role);

describe("can() — full matrix (7 roles × all permission keys)", () => {
  for (const role of ALL_ROLES) {
    for (const key of ALL_PERMISSIONS) {
      const expected = EXPECTED[role].includes(key);
      it(`${role} ${expected ? "CAN" : "cannot"} ${key}`, () => {
        expect(can(role, key)).toBe(expected);
      });
    }
  }
});

describe("invariants", () => {
  it("Admin is a superset (true for every key)", () => {
    for (const key of ALL_PERMISSIONS) {
      expect(can(Role.Admin, key)).toBe(true);
    }
  });

  it("manage_users and view_audit_log are Admin-only", () => {
    for (const role of ALL_ROLES) {
      const adminOnly = role === Role.Admin;
      expect(can(role, "manage_users")).toBe(adminOnly);
      expect(can(role, "view_audit_log")).toBe(adminOnly);
    }
  });

  it("Executive Viewer can only view_all_trips and view_freight_rates (016)", () => {
    for (const key of ALL_PERMISSIONS) {
      expect(can(Role.ExecutiveViewer, key)).toBe(
        key === "view_all_trips" || key === "view_freight_rates",
      );
    }
  });

  it("customer_viewer is not an assignable role", () => {
    expect(ASSIGNABLE_ROLES).not.toContain("customer_viewer");
    expect(ASSIGNABLE_ROLES).toHaveLength(7);
  });

  it("can() returns false for an unknown role", () => {
    expect(can("customer_viewer" as RoleType, "view_all_trips")).toBe(false);
  });
});

describe("002 master-data permission invariants (contracts/permission-matrix.md)", () => {
  it("Admin and Ops Manager hold both manage_commercial_data and manage_fleet_data", () => {
    for (const role of [Role.Admin, Role.OperationsManager] as const) {
      expect(can(role, "manage_commercial_data")).toBe(true);
      expect(can(role, "manage_fleet_data")).toBe(true);
    }
  });

  it("Fleet Coordinator manages fleet but NOT commercial data", () => {
    expect(can(Role.FleetCoordinator, "manage_fleet_data")).toBe(true);
    expect(can(Role.FleetCoordinator, "manage_commercial_data")).toBe(false);
  });

  it("manage_commercial_data and manage_fleet_data are granted to no other role", () => {
    const otherRoles = [
      Role.Dispatcher,
      Role.ControlTower,
      Role.Finance,
      Role.ExecutiveViewer,
    ] as const;
    for (const role of otherRoles) {
      expect(can(role, "manage_commercial_data")).toBe(false);
      expect(can(role, "manage_fleet_data")).toBe(false);
    }
  });

  it("archive of master data uses the Admin-only delete_archive key", () => {
    for (const role of ALL_ROLES) {
      expect(can(role, "delete_archive")).toBe(role === Role.Admin);
    }
  });
});

describe("003 trip-domain permission invariants (contracts/permission-matrix.md)", () => {
  it("Admin and Operations Manager hold manage_trips", () => {
    expect(can(Role.Admin, "manage_trips")).toBe(true);
    expect(can(Role.OperationsManager, "manage_trips")).toBe(true);
  });

  it("Dispatcher and Finance do NOT hold manage_trips (their trip keys arrive in later slices)", () => {
    expect(can(Role.Dispatcher, "manage_trips")).toBe(false);
    expect(can(Role.Finance, "manage_trips")).toBe(false);
  });

  it("no other role holds manage_trips", () => {
    for (const role of ALL_ROLES) {
      const expected = role === Role.Admin || role === Role.OperationsManager;
      expect(can(role, "manage_trips")).toBe(expected);
    }
  });

  it("customer_viewer (reserved, non-assignable) does not hold manage_trips", () => {
    expect(can("customer_viewer" as RoleType, "manage_trips")).toBe(false);
  });
});

describe("004 trip-import permission invariants (contracts/permission-matrix.md — import_trips, no new key)", () => {
  it("Admin and Operations Manager hold import_trips", () => {
    expect(can(Role.Admin, "import_trips")).toBe(true);
    expect(can(Role.OperationsManager, "import_trips")).toBe(true);
  });

  it("Dispatcher, Control Tower, Finance, Executive Viewer do NOT hold import_trips", () => {
    expect(can(Role.Dispatcher, "import_trips")).toBe(false);
    expect(can(Role.ControlTower, "import_trips")).toBe(false);
    expect(can(Role.Finance, "import_trips")).toBe(false);
    expect(can(Role.ExecutiveViewer, "import_trips")).toBe(false);
  });

  it("import_trips is granted to exactly Admin + Operations Manager", () => {
    for (const role of ALL_ROLES) {
      const expected = role === Role.Admin || role === Role.OperationsManager;
      expect(can(role, "import_trips")).toBe(expected);
    }
  });

  it("customer_viewer (reserved, non-assignable) does not hold import_trips", () => {
    expect(can("customer_viewer" as RoleType, "import_trips")).toBe(false);
  });
});

describe("005 control-tower permission invariants (contracts/permission-matrix.md — first enforcement of view_all_trips)", () => {
  it("all 7 internal roles hold view_all_trips (read the Control Tower / detail / dashboard / export)", () => {
    for (const role of ALL_ROLES) {
      expect(can(role, "view_all_trips")).toBe(true);
    }
    expect(ALL_ROLES).toHaveLength(7);
  });

  it("editing live planned fields stays manage_trips (Admin + Ops Manager only; the 'Limited' scope is BLOCKED)", () => {
    expect(can(Role.Admin, "manage_trips")).toBe(true);
    expect(can(Role.OperationsManager, "manage_trips")).toBe(true);
    expect(can(Role.Dispatcher, "manage_trips")).toBe(false);
    expect(can(Role.ControlTower, "manage_trips")).toBe(false);
    expect(can(Role.FleetCoordinator, "manage_trips")).toBe(false);
    expect(can(Role.Finance, "manage_trips")).toBe(false);
    expect(can(Role.ExecutiveViewer, "manage_trips")).toBe(false);
  });
});

describe("006 dispatch-assignment permission invariants (contracts/permission-matrix.md — first enforcement of assign_resources)", () => {
  it("assign_resources is granted to Admin, Operations Manager, Dispatcher, and Fleet Coordinator", () => {
    for (const role of [
      Role.Admin,
      Role.OperationsManager,
      Role.Dispatcher,
      Role.FleetCoordinator,
    ] as const) {
      expect(can(role, "assign_resources")).toBe(true);
    }
  });

  it("assign_resources is denied to Control Tower, Finance, and Executive Viewer", () => {
    for (const role of [Role.ControlTower, Role.Finance, Role.ExecutiveViewer] as const) {
      expect(can(role, "assign_resources")).toBe(false);
    }
  });

  it("assign_resources is granted to exactly those four roles", () => {
    for (const role of ALL_ROLES) {
      const expected =
        role === Role.Admin ||
        role === Role.OperationsManager ||
        role === Role.Dispatcher ||
        role === Role.FleetCoordinator;
      expect(can(role, "assign_resources")).toBe(expected);
    }
  });

  it("a Dispatcher holding assign_resources does NOT hold manage_fleet_data (the resource-options gap 006 fills)", () => {
    expect(can(Role.Dispatcher, "assign_resources")).toBe(true);
    expect(can(Role.Dispatcher, "manage_fleet_data")).toBe(false);
  });
});

describe("007 execution/exception/SLA permission invariants (contracts/permission-matrix.md — no new key)", () => {
  it("update_trip_status (milestones/notes) is granted to Admin, Ops Manager, Dispatcher, Control Tower", () => {
    for (const role of [
      Role.Admin,
      Role.OperationsManager,
      Role.Dispatcher,
      Role.ControlTower,
    ] as const) {
      expect(can(role, "update_trip_status")).toBe(true);
    }
  });

  it("update_trip_status is denied to Fleet Coordinator, Finance, Executive Viewer", () => {
    for (const role of [Role.FleetCoordinator, Role.Finance, Role.ExecutiveViewer] as const) {
      expect(can(role, "update_trip_status")).toBe(false);
    }
  });

  it("create_exceptions/resolve_exceptions are granted to those four PLUS Fleet Coordinator", () => {
    for (const role of [
      Role.Admin,
      Role.OperationsManager,
      Role.Dispatcher,
      Role.ControlTower,
      Role.FleetCoordinator,
    ] as const) {
      expect(can(role, "create_exceptions")).toBe(true);
      expect(can(role, "resolve_exceptions")).toBe(true);
    }
  });

  it("create_exceptions/resolve_exceptions are denied to Finance and Executive Viewer", () => {
    for (const role of [Role.Finance, Role.ExecutiveViewer] as const) {
      expect(can(role, "create_exceptions")).toBe(false);
      expect(can(role, "resolve_exceptions")).toBe(false);
    }
  });

  it("SLA-rule admin reuses manage_commercial_data (Admin + Ops Manager only)", () => {
    for (const role of ALL_ROLES) {
      const expected = role === Role.Admin || role === Role.OperationsManager;
      expect(can(role, "manage_commercial_data")).toBe(expected);
    }
  });
});

describe("008 documents/billing permission invariants (contracts/permission-matrix.md — first enforcement, no new key)", () => {
  it("upload_documents = everyone except Executive Viewer", () => {
    for (const role of [
      Role.Admin,
      Role.OperationsManager,
      Role.Dispatcher,
      Role.ControlTower,
      Role.FleetCoordinator,
      Role.Finance,
    ] as const) {
      expect(can(role, "upload_documents")).toBe(true);
    }
    expect(can(Role.ExecutiveViewer, "upload_documents")).toBe(false);
  });

  it("verify_documents = Admin, Ops Manager, Finance", () => {
    for (const role of ALL_ROLES) {
      const expected =
        role === Role.Admin || role === Role.OperationsManager || role === Role.Finance;
      expect(can(role, "verify_documents")).toBe(expected);
    }
  });

  it("mark_completed = Admin, Ops Manager, Control Tower", () => {
    for (const role of ALL_ROLES) {
      const expected =
        role === Role.Admin || role === Role.OperationsManager || role === Role.ControlTower;
      expect(can(role, "mark_completed")).toBe(expected);
    }
  });

  it("mark_billing_ready / edit_rates / export_billing = Admin + Finance only", () => {
    for (const key of ["mark_billing_ready", "edit_rates", "export_billing"] as const) {
      for (const role of ALL_ROLES) {
        const expected = role === Role.Admin || role === Role.Finance;
        expect(can(role, key)).toBe(expected);
      }
    }
  });

  it("document requirements/types reuse manage_commercial_data (Admin + Ops Manager)", () => {
    for (const role of ALL_ROLES) {
      const expected = role === Role.Admin || role === Role.OperationsManager;
      expect(can(role, "manage_commercial_data")).toBe(expected);
    }
  });

  it("Ops Manager holds mark_completed but NOT mark_billing_ready (Finance owns the billing gate)", () => {
    expect(can(Role.OperationsManager, "mark_completed")).toBe(true);
    expect(can(Role.OperationsManager, "mark_billing_ready")).toBe(false);
  });

  it("a Dispatcher can upload but cannot verify (verify is the review authority)", () => {
    expect(can(Role.Dispatcher, "upload_documents")).toBe(true);
    expect(can(Role.Dispatcher, "verify_documents")).toBe(false);
  });
});
