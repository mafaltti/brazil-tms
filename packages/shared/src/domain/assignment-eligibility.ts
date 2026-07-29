import { documentExpiryState } from "../formatting";
import type { ResourceStatus, VehicleType } from "../schemas/master-data";

/**
 * Pure, DB-free assignment-eligibility evaluator (data-model.md §3.1–§3.3, research §6/§7/§9).
 *
 * This is the SINGLE source of conflict/eligibility authority (Constitution III): the DB layer gathers
 * the {@link EligibilityContext} (candidate resources + the trip window/type + overlapping CURRENT
 * assignments) and calls {@link evaluateAssignmentEligibility}; the BFF enforces the outcome
 * (`block` ⇒ refuse, `warn` ⇒ require an override reason). The UI calls the dry-run check endpoint to
 * *display* findings but never decides. Implements the PRD §19.2 check set:
 *   schedule overlap · resource status · vehicle-type match · carrier eligibility · documentation.
 *
 * Block/warn is config ({@link DEFAULT_ASSIGNMENT_POLICY}, the confirmed company default — research §7)
 * with a per-customer override seam ({@link resolveSeverity}); NO per-customer storage is built (YAGNI).
 */

// ---------------------------------------------------------------------------
// Types (data-model.md §3.1)
// ---------------------------------------------------------------------------

/** The five §19.2 eligibility checks a finding can belong to. */
export type AssignmentCheck =
  | "schedule_conflict"
  | "resource_status"
  | "vehicle_type"
  | "carrier_eligibility"
  | "documentation";

/** A finding's severity: `block` cannot be bypassed; `warn` requires a recorded override reason. */
export type Severity = "block" | "warn";

/** One eligibility finding against a candidate resource (the evaluator returns zero or more). */
export interface Finding {
  check: AssignmentCheck;
  resourceKind: "driver" | "vehicle" | "trailer" | "carrier";
  resourceId: string;
  severity: Severity;
  /** Stable finding code, e.g. `driver_blocked`, `doc_expired`, `type_mismatch`, `schedule_overlap`. */
  code: string;
}

/** The data the evaluator needs — gathered DB-side, then evaluated purely (data-model.md §3.1). */
export interface EligibilityContext {
  trip: {
    plannedVehicleType: VehicleType | null;
    windowStart: Date | null;
    windowEnd: Date | null;
  };
  driver?: { id: string; status: ResourceStatus; licenseExpiry: string | null; archived?: boolean };
  vehicle?: {
    id: string;
    status: ResourceStatus;
    vehicleType: VehicleType;
    documentExpiry: string | null;
    archived?: boolean;
  };
  trailer?: { id: string; status: ResourceStatus; documentExpiry: string | null; archived?: boolean };
  carrier?: { id: string; contractStatus: string; documentationStatus: string; archived: boolean };
  /** Current assignments of the candidate resources whose trip window intersects this trip's window. */
  overlaps: { resourceKind: "driver" | "vehicle" | "trailer"; resourceId: string }[];
  now: Date;
}

// ---------------------------------------------------------------------------
// Policy config — confirmed company default (data-model.md §3.2, research §7)
// ---------------------------------------------------------------------------

/** Maps each finding code to its severity. The override seam for per-customer policy (no storage). */
export interface AssignmentPolicy {
  severity: Record<string /* findingCode */, Severity>;
}

/**
 * The confirmed company-default block/warn map (data-model.md §3.2 — copied verbatim). BLOCK = resource
 * inactive/blocked, vehicle/trailer maintenance, expired docs, carrier not-active/contract-or-doc-expired;
 * WARN = schedule overlap, vehicle-type mismatch, missing/expiring docs, resource unavailable, carrier
 * doc pending.
 */
export const DEFAULT_ASSIGNMENT_POLICY: AssignmentPolicy = {
  severity: {
    driver_inactive: "block",
    driver_blocked: "block",
    driver_unavailable: "warn",
    driver_archived: "block",
    vehicle_inactive: "block",
    vehicle_blocked: "block",
    vehicle_maintenance: "block",
    vehicle_unavailable: "warn",
    vehicle_archived: "block",
    trailer_inactive: "block",
    trailer_blocked: "block",
    trailer_unavailable: "warn",
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
  },
};

/**
 * Resolve a finding code's severity against a policy (per-customer override seam, research §7). An
 * unmapped code defaults to `warn` (surface, never silently block) — the documented default.
 */
export function resolveSeverity(
  code: string,
  policy: AssignmentPolicy = DEFAULT_ASSIGNMENT_POLICY,
): Severity {
  return policy.severity[code] ?? "warn";
}

// ---------------------------------------------------------------------------
// Required-resource rule (data-model.md §3.3, research §9)
// ---------------------------------------------------------------------------

/**
 * The minimum-required resource set for an assignment, by the assigned resources' ownership. Driver and
 * vehicle are always required; a carrier is required iff the assigned resources are subcontracted; a
 * trailer is always optional. `ownership` is derived from the chosen resources' `ownership_type`, not
 * from any `trips` column (a trip has none — data-model.md §3.3).
 */
export function requiredResourcesFor(ownership: "owned" | "subcontracted"): {
  driver: true;
  vehicle: true;
  carrier: boolean;
} {
  return { driver: true, vehicle: true, carrier: ownership === "subcontracted" };
}

/** Turnaround buffer applied to schedule-overlap detection, in minutes. Default 0 (spec Blocked #6). */
export const ASSIGNMENT_TURNAROUND_BUFFER_MINUTES = 0;

// ---------------------------------------------------------------------------
// Evaluator (data-model.md §3.1, research §6 — PRD §19.2)
// ---------------------------------------------------------------------------

/** A non-`active` resource status maps to a `<kind>_<status>` finding code (e.g. `driver_blocked`). */
function statusCode(kind: "driver" | "vehicle" | "trailer", status: ResourceStatus): string {
  return `${kind}_${status}`;
}

/** Map the documentation-expiry state (002 helper) onto a finding code; null/missing ⇒ `doc_missing`. */
function documentationCode(expiry: string | null, now: Date): string | null {
  if (expiry == null) return "doc_missing";
  const state = documentExpiryState(expiry, now);
  if (state === "expired") return "doc_expired";
  if (state === "expiring") return "doc_expiring";
  return null; // ok — no finding
}

/**
 * Evaluate every §19.2 check for the candidate resources in `ctx`, returning one {@link Finding} per
 * issue with its policy-resolved severity. Pure: no DB, no clock — `ctx.now` drives expiry math.
 */
export function evaluateAssignmentEligibility(
  ctx: EligibilityContext,
  policy: AssignmentPolicy = DEFAULT_ASSIGNMENT_POLICY,
): Finding[] {
  const findings: Finding[] = [];
  const push = (
    check: AssignmentCheck,
    resourceKind: Finding["resourceKind"],
    resourceId: string,
    code: string,
  ) =>
    findings.push({
      check,
      resourceKind,
      resourceId,
      code,
      severity: resolveSeverity(code, policy),
    });

  // 1. Schedule overlap — one finding per overlapping current assignment (research §6).
  for (const overlap of ctx.overlaps) {
    push("schedule_conflict", overlap.resourceKind, overlap.resourceId, "schedule_overlap");
  }

  // 2. Resource status — any non-`active` driver/vehicle/trailer status (`<kind>_<status>`), plus an
  //    `<kind>_archived` BLOCK for a soft-deleted (archived) resource. Archived is ORTHOGONAL to
  //    `status` (an archived resource can still be status `active`), so it fires independently — this
  //    keeps the server-authoritative surface in step with the UI pickers, which hide archived
  //    resources (`isNull(archived_at)`). Mirrors the carrier's archived handling below.
  if (ctx.driver && ctx.driver.status !== "active") {
    push("resource_status", "driver", ctx.driver.id, statusCode("driver", ctx.driver.status));
  }
  if (ctx.driver?.archived) {
    push("resource_status", "driver", ctx.driver.id, "driver_archived");
  }
  if (ctx.vehicle && ctx.vehicle.status !== "active") {
    push("resource_status", "vehicle", ctx.vehicle.id, statusCode("vehicle", ctx.vehicle.status));
  }
  if (ctx.vehicle?.archived) {
    push("resource_status", "vehicle", ctx.vehicle.id, "vehicle_archived");
  }
  if (ctx.trailer && ctx.trailer.status !== "active") {
    push("resource_status", "trailer", ctx.trailer.id, statusCode("trailer", ctx.trailer.status));
  }
  if (ctx.trailer?.archived) {
    push("resource_status", "trailer", ctx.trailer.id, "trailer_archived");
  }

  // 3. Vehicle-type exact match vs the trip's planned type (skip when the trip has no planned type).
  if (
    ctx.vehicle &&
    ctx.trip.plannedVehicleType != null &&
    ctx.vehicle.vehicleType !== ctx.trip.plannedVehicleType
  ) {
    push("vehicle_type", "vehicle", ctx.vehicle.id, "type_mismatch");
  }

  // 4. Carrier eligibility — contract/documentation status + archived.
  if (ctx.carrier) {
    if (ctx.carrier.archived) {
      push("carrier_eligibility", "carrier", ctx.carrier.id, "carrier_inactive");
    } else if (ctx.carrier.contractStatus !== "active") {
      // `expired` ⇒ carrier_contract_expired; any other non-active (e.g. `suspended`) ⇒ carrier_inactive.
      const code =
        ctx.carrier.contractStatus === "expired" ? "carrier_contract_expired" : "carrier_inactive";
      push("carrier_eligibility", "carrier", ctx.carrier.id, code);
    }
    if (ctx.carrier.documentationStatus === "expired") {
      push("carrier_eligibility", "carrier", ctx.carrier.id, "carrier_doc_expired");
    } else if (ctx.carrier.documentationStatus === "pending") {
      push("carrier_eligibility", "carrier", ctx.carrier.id, "carrier_doc_pending");
    }
  }

  // 5. Documentation expiry — driver license + vehicle/trailer document (002 `documentExpiryState`).
  if (ctx.driver) {
    const code = documentationCode(ctx.driver.licenseExpiry, ctx.now);
    if (code) push("documentation", "driver", ctx.driver.id, code);
  }
  if (ctx.vehicle) {
    const code = documentationCode(ctx.vehicle.documentExpiry, ctx.now);
    if (code) push("documentation", "vehicle", ctx.vehicle.id, code);
  }
  if (ctx.trailer) {
    const code = documentationCode(ctx.trailer.documentExpiry, ctx.now);
    if (code) push("documentation", "trailer", ctx.trailer.id, code);
  }

  return findings;
}
