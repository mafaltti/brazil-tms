import { describe, expect, it } from "vitest";
import {
  ASSIGNMENT_TURNAROUND_BUFFER_MINUTES,
  DEFAULT_ASSIGNMENT_POLICY,
  evaluateAssignmentEligibility,
  requiredResourcesFor,
  resolveSeverity,
  type AssignmentPolicy,
  type EligibilityContext,
  type Finding,
} from "./assignment-eligibility";

/**
 * Pure unit tests for the assignment-eligibility evaluator (data-model.md §3.1–§3.3, research §6/§7/§9).
 * Covers every §19.2 check × severity, every DEFAULT_ASSIGNMENT_POLICY entry, the required-resource
 * rule, and the turnaround-buffer default. No DB, no real clock — `ctx.now` drives expiry math.
 */

const NOW = new Date("2026-05-31T12:00:00.000Z");
const DRIVER = "d0000000-0000-0000-0000-000000000001";
const VEHICLE = "v0000000-0000-0000-0000-000000000001";
const TRAILER = "t0000000-0000-0000-0000-000000000001";
const CARRIER = "c0000000-0000-0000-0000-000000000001";

/** A clean context: every present resource is active, in-date, type-matched, no overlaps. */
function cleanCtx(over: Partial<EligibilityContext> = {}): EligibilityContext {
  return {
    trip: { plannedVehicleType: "truck", windowStart: NOW, windowEnd: NOW },
    driver: { id: DRIVER, status: "active", licenseExpiry: "2027-01-01" },
    vehicle: { id: VEHICLE, status: "active", vehicleType: "truck", documentExpiry: "2027-01-01" },
    overlaps: [],
    now: NOW,
    ...over,
  };
}

const codesOf = (f: Finding[]) => f.map((x) => x.code);
const find = (f: Finding[], code: string) => f.find((x) => x.code === code);

describe("evaluateAssignmentEligibility — clean context", () => {
  it("returns no findings when everything is active, matched, and in-date", () => {
    expect(evaluateAssignmentEligibility(cleanCtx())).toEqual([]);
  });
});

describe("schedule_conflict check", () => {
  it("emits one schedule_overlap finding per overlap entry (warn)", () => {
    const findings = evaluateAssignmentEligibility(
      cleanCtx({
        overlaps: [
          { resourceKind: "driver", resourceId: DRIVER },
          { resourceKind: "vehicle", resourceId: VEHICLE },
        ],
      }),
    );
    const overlaps = findings.filter((x) => x.code === "schedule_overlap");
    expect(overlaps).toHaveLength(2);
    for (const f of overlaps) {
      expect(f.check).toBe("schedule_conflict");
      expect(f.severity).toBe("warn");
    }
    expect(overlaps.map((x) => x.resourceKind).sort()).toEqual(["driver", "vehicle"]);
  });
});

describe("resource_status check — non-active driver/vehicle/trailer", () => {
  const cases: {
    kind: "driver" | "vehicle" | "trailer";
    status: string;
    code: string;
    severity: string;
  }[] = [
    { kind: "driver", status: "inactive", code: "driver_inactive", severity: "block" },
    { kind: "driver", status: "blocked", code: "driver_blocked", severity: "block" },
    { kind: "driver", status: "unavailable", code: "driver_unavailable", severity: "warn" },
    { kind: "vehicle", status: "inactive", code: "vehicle_inactive", severity: "block" },
    { kind: "vehicle", status: "blocked", code: "vehicle_blocked", severity: "block" },
    { kind: "vehicle", status: "maintenance", code: "vehicle_maintenance", severity: "block" },
    { kind: "vehicle", status: "unavailable", code: "vehicle_unavailable", severity: "warn" },
    { kind: "trailer", status: "inactive", code: "trailer_inactive", severity: "block" },
    { kind: "trailer", status: "blocked", code: "trailer_blocked", severity: "block" },
    { kind: "trailer", status: "unavailable", code: "trailer_unavailable", severity: "warn" },
  ];

  for (const c of cases) {
    it(`${c.kind} ${c.status} → ${c.code} (${c.severity})`, () => {
      const ctx = cleanCtx();
      if (c.kind === "driver")
        ctx.driver = { id: DRIVER, status: c.status as never, licenseExpiry: "2027-01-01" };
      if (c.kind === "vehicle")
        ctx.vehicle = {
          id: VEHICLE,
          status: c.status as never,
          vehicleType: "truck",
          documentExpiry: "2027-01-01",
        };
      if (c.kind === "trailer")
        ctx.trailer = { id: TRAILER, status: c.status as never, documentExpiry: "2027-01-01" };
      const f = find(evaluateAssignmentEligibility(ctx), c.code);
      expect(f).toBeDefined();
      expect(f?.check).toBe("resource_status");
      expect(f?.resourceKind).toBe(c.kind);
      expect(f?.severity).toBe(c.severity);
    });
  }

  it("active resources produce no resource_status finding", () => {
    const findings = evaluateAssignmentEligibility(cleanCtx());
    expect(findings.some((x) => x.check === "resource_status")).toBe(false);
  });
});

describe("resource_status check — archived resources (orthogonal to status)", () => {
  for (const kind of ["driver", "vehicle", "trailer"] as const) {
    it(`archived ${kind} → ${kind}_archived (block), even when status is active`, () => {
      const ctx = cleanCtx();
      if (kind === "driver")
        ctx.driver = { id: DRIVER, status: "active", licenseExpiry: "2027-01-01", archived: true };
      if (kind === "vehicle")
        ctx.vehicle = {
          id: VEHICLE,
          status: "active",
          vehicleType: "truck",
          documentExpiry: "2027-01-01",
          archived: true,
        };
      if (kind === "trailer")
        ctx.trailer = { id: TRAILER, status: "active", documentExpiry: "2027-01-01", archived: true };
      const f = find(evaluateAssignmentEligibility(ctx), `${kind}_archived`);
      expect(f).toBeDefined();
      expect(f?.check).toBe("resource_status");
      expect(f?.resourceKind).toBe(kind);
      expect(f?.severity).toBe("block"); // a soft-deleted resource is never eligible
    });
  }

  it("a non-archived (archived:false / undefined) resource produces no *_archived finding", () => {
    const findings = evaluateAssignmentEligibility(cleanCtx());
    expect(findings.some((x) => x.code.endsWith("_archived"))).toBe(false);
  });
});

describe("vehicle_type check — exact match vs planned type", () => {
  it("type_mismatch (warn) when the vehicle type differs from the planned type", () => {
    const ctx = cleanCtx();
    ctx.vehicle = {
      id: VEHICLE,
      status: "active",
      vehicleType: "van",
      documentExpiry: "2027-01-01",
    };
    const f = find(evaluateAssignmentEligibility(ctx), "type_mismatch");
    expect(f?.check).toBe("vehicle_type");
    expect(f?.severity).toBe("warn");
  });

  it("no finding when the planned type is null (skip)", () => {
    const ctx = cleanCtx({ trip: { plannedVehicleType: null, windowStart: NOW, windowEnd: NOW } });
    ctx.vehicle = {
      id: VEHICLE,
      status: "active",
      vehicleType: "van",
      documentExpiry: "2027-01-01",
    };
    expect(codesOf(evaluateAssignmentEligibility(ctx))).not.toContain("type_mismatch");
  });

  it("no finding when the types match exactly", () => {
    expect(codesOf(evaluateAssignmentEligibility(cleanCtx()))).not.toContain("type_mismatch");
  });
});

describe("carrier_eligibility check", () => {
  const base = {
    id: CARRIER,
    contractStatus: "active",
    documentationStatus: "complete",
    archived: false,
  };

  it("archived carrier → carrier_inactive (block)", () => {
    const f = find(
      evaluateAssignmentEligibility(cleanCtx({ carrier: { ...base, archived: true } })),
      "carrier_inactive",
    );
    expect(f?.check).toBe("carrier_eligibility");
    expect(f?.severity).toBe("block");
  });

  it("suspended contract → carrier_inactive (block)", () => {
    const f = find(
      evaluateAssignmentEligibility(
        cleanCtx({ carrier: { ...base, contractStatus: "suspended" } }),
      ),
      "carrier_inactive",
    );
    expect(f?.severity).toBe("block");
  });

  it("expired contract → carrier_contract_expired (block)", () => {
    const f = find(
      evaluateAssignmentEligibility(cleanCtx({ carrier: { ...base, contractStatus: "expired" } })),
      "carrier_contract_expired",
    );
    expect(f?.severity).toBe("block");
  });

  it("expired documentation → carrier_doc_expired (block)", () => {
    const f = find(
      evaluateAssignmentEligibility(
        cleanCtx({ carrier: { ...base, documentationStatus: "expired" } }),
      ),
      "carrier_doc_expired",
    );
    expect(f?.severity).toBe("block");
  });

  it("pending documentation → carrier_doc_pending (warn)", () => {
    const f = find(
      evaluateAssignmentEligibility(
        cleanCtx({ carrier: { ...base, documentationStatus: "pending" } }),
      ),
      "carrier_doc_pending",
    );
    expect(f?.severity).toBe("warn");
  });

  it("active + complete + not-archived carrier → no carrier finding", () => {
    const findings = evaluateAssignmentEligibility(cleanCtx({ carrier: { ...base } }));
    expect(findings.some((x) => x.check === "carrier_eligibility")).toBe(false);
  });

  it("no carrier in context → no carrier finding", () => {
    expect(
      evaluateAssignmentEligibility(cleanCtx()).some((x) => x.check === "carrier_eligibility"),
    ).toBe(false);
  });
});

describe("documentation check — driver license + vehicle/trailer document", () => {
  it("expired license → doc_expired (block)", () => {
    const ctx = cleanCtx();
    ctx.driver = { id: DRIVER, status: "active", licenseExpiry: "2026-05-31" }; // today = expired
    const f = find(evaluateAssignmentEligibility(ctx), "doc_expired");
    expect(f?.check).toBe("documentation");
    expect(f?.resourceKind).toBe("driver");
    expect(f?.severity).toBe("block");
  });

  it("expiring-soon document → doc_expiring (warn)", () => {
    const ctx = cleanCtx();
    ctx.vehicle = {
      id: VEHICLE,
      status: "active",
      vehicleType: "truck",
      documentExpiry: "2026-06-10",
    }; // within 30d
    const f = find(evaluateAssignmentEligibility(ctx), "doc_expiring");
    expect(f?.severity).toBe("warn");
  });

  it("missing/null document → doc_missing (warn)", () => {
    const ctx = cleanCtx();
    ctx.trailer = { id: TRAILER, status: "active", documentExpiry: null };
    const f = find(evaluateAssignmentEligibility(ctx), "doc_missing");
    expect(f?.check).toBe("documentation");
    expect(f?.resourceKind).toBe("trailer");
    expect(f?.severity).toBe("warn");
  });

  it("in-date document → no documentation finding", () => {
    expect(evaluateAssignmentEligibility(cleanCtx()).some((x) => x.check === "documentation")).toBe(
      false,
    );
  });
});

describe("policy override seam (resolveSeverity)", () => {
  it("an unmapped code defaults to warn", () => {
    expect(resolveSeverity("totally_unknown_code")).toBe("warn");
  });

  it("a custom policy overrides the default severity", () => {
    const policy: AssignmentPolicy = { severity: { schedule_overlap: "block" } };
    const findings = evaluateAssignmentEligibility(
      cleanCtx({ overlaps: [{ resourceKind: "driver", resourceId: DRIVER }] }),
      policy,
    );
    expect(find(findings, "schedule_overlap")?.severity).toBe("block");
  });

  it("evaluator severities all come from resolveSeverity(code, policy)", () => {
    const ctx = cleanCtx();
    ctx.driver = { id: DRIVER, status: "blocked", licenseExpiry: "2027-01-01" };
    const f = find(evaluateAssignmentEligibility(ctx), "driver_blocked");
    expect(f?.severity).toBe(resolveSeverity("driver_blocked"));
  });
});

describe("DEFAULT_ASSIGNMENT_POLICY (data-model.md §3.2 — verbatim)", () => {
  const expected: Record<string, string> = {
    driver_inactive: "block",
    driver_blocked: "block",
    driver_unavailable: "warn",
    vehicle_inactive: "block",
    vehicle_blocked: "block",
    vehicle_maintenance: "block",
    vehicle_unavailable: "warn",
    trailer_inactive: "block",
    trailer_blocked: "block",
    trailer_unavailable: "warn",
    driver_archived: "block",
    vehicle_archived: "block",
    trailer_archived: "block",
    doc_expired: "block",
    doc_missing: "warn",
    doc_expiring: "warn",
    carrier_inactive: "block",
    carrier_contract_expired: "block",
    carrier_doc_expired: "block",
    carrier_doc_pending: "warn",
    type_mismatch: "warn",
    schedule_overlap: "warn",
  };

  it("maps each finding code to the confirmed company-default severity", () => {
    expect(DEFAULT_ASSIGNMENT_POLICY.severity).toEqual(expected);
  });

  it("has exactly the documented set of codes (no extras, none missing)", () => {
    expect(Object.keys(DEFAULT_ASSIGNMENT_POLICY.severity).sort()).toEqual(
      Object.keys(expected).sort(),
    );
  });
});

describe("requiredResourcesFor (data-model.md §3.3, research §9)", () => {
  it("owned → driver + vehicle required, carrier NOT required", () => {
    expect(requiredResourcesFor("owned")).toEqual({ driver: true, vehicle: true, carrier: false });
  });

  it("subcontracted → driver + vehicle + carrier required", () => {
    expect(requiredResourcesFor("subcontracted")).toEqual({
      driver: true,
      vehicle: true,
      carrier: true,
    });
  });
});

describe("ASSIGNMENT_TURNAROUND_BUFFER_MINUTES default", () => {
  it("is 0 (spec Blocked #6 documented default)", () => {
    expect(ASSIGNMENT_TURNAROUND_BUFFER_MINUTES).toBe(0);
  });
});
