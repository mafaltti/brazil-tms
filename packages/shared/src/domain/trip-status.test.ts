import { describe, expect, it } from "vitest";
import {
  ACTIVE_TRIP_STATUSES,
  BILLING_PHASE_STATUSES,
  DISPATCH_PHASE_TRIP_STATUSES,
  NON_EDITABLE_TRIP_STATUSES,
  TRANSITIONS,
  TRIP_CRITICAL_FIELDS,
  TRIP_STATUSES,
  billingStatus,
  billingStatusToStatuses,
  canTransition,
  isActiveStatus,
  isNonEditableStatus,
  type BillingStatus,
  type TripStatus,
} from "./trip-status";

/**
 * Pure unit tests for the single trip domain model (FR-008..FR-013, FR-016). No DB. This module is
 * the source of truth slices 004–009 import, so its legality table, projection, and critical-field
 * set are pinned here. Billing-projection assertions (US5, T031) are appended in the dedicated block
 * at the bottom.
 */

describe("TRIP_STATUSES", () => {
  it("has exactly the 16 spec statuses (slice 015 collapsed the two validation states)", () => {
    expect(TRIP_STATUSES).toHaveLength(16);
  });

  it("does NOT contain 'warning' — a validation warning is an attention flag, not a status (FR-012)", () => {
    expect((TRIP_STATUSES as readonly string[]).includes("warning")).toBe(false);
  });
});

describe("DISPATCH_PHASE_TRIP_STATUSES (017 R2 — the §18 Dispatcher-'Limited' cancel boundary)", () => {
  it("is exactly the three pre-execution statuses, in lifecycle order", () => {
    expect(DISPATCH_PHASE_TRIP_STATUSES).toEqual(["received", "assigned", "confirmed"]);
  });

  it("is a subset of TRIP_STATUSES and of the active/open set", () => {
    for (const s of DISPATCH_PHASE_TRIP_STATUSES) {
      expect(TRIP_STATUSES).toContain(s);
      expect(isActiveStatus(s)).toBe(true);
    }
  });

  it("every member is legally cancellable (the limit narrows, never widens, cancellability)", () => {
    for (const s of DISPATCH_PHASE_TRIP_STATUSES) {
      expect(canTransition(s, "cancelled")).toBe(true);
    }
  });
});

describe("canTransition — every declared legal transition is accepted", () => {
  for (const from of TRIP_STATUSES) {
    for (const to of TRANSITIONS[from]) {
      it(`${from} → ${to} is legal`, () => {
        expect(canTransition(from, to)).toBe(true);
      });
    }
  }
});

describe("canTransition — illegal transitions are rejected", () => {
  it("received → in_transit is illegal (must pass through assignment)", () => {
    expect(canTransition("received", "in_transit")).toBe(false);
  });

  it("received → completed is illegal", () => {
    expect(canTransition("received", "completed")).toBe(false);
  });

  it("received → confirmed is illegal (must be assigned first)", () => {
    expect(canTransition("received", "confirmed")).toBe(false);
  });

  it("billing_pending → billed is illegal (must pass through billing_ready)", () => {
    expect(canTransition("billing_pending", "billed")).toBe(false);
  });
});

describe("optional sub-states may be skipped (FR-010)", () => {
  it("at_origin → in_transit (skip loading) is legal", () => {
    expect(canTransition("at_origin", "in_transit")).toBe(true);
  });

  it("at_destination → unloaded (skip unloading) is legal", () => {
    expect(canTransition("at_destination", "unloaded")).toBe(true);
  });
});

describe("cancellation availability (clarification 2026-05-29: legal through at_destination)", () => {
  it("in_transit → cancelled is legal", () => {
    expect(canTransition("in_transit", "cancelled")).toBe(true);
  });

  it("at_destination → cancelled is legal", () => {
    expect(canTransition("at_destination", "cancelled")).toBe(true);
  });

  it("unloaded → cancelled is illegal (past the cancellable window)", () => {
    expect(canTransition("unloaded", "cancelled")).toBe(false);
  });

  it("completed → cancelled is illegal", () => {
    expect(canTransition("completed", "cancelled")).toBe(false);
  });
});

describe("cancelled is terminal", () => {
  it("has no outgoing transitions", () => {
    expect(TRANSITIONS.cancelled).toHaveLength(0);
  });

  it("cannot transition to any other status", () => {
    for (const to of TRIP_STATUSES) {
      expect(canTransition("cancelled", to)).toBe(false);
    }
  });
});

describe("disputed round-trip (FR-011)", () => {
  it("disputed → cancelled is legal (static)", () => {
    expect(canTransition("disputed", "cancelled")).toBe(true);
  });

  it("disputed → its disputed_from_status is legal when supplied", () => {
    expect(canTransition("disputed", "billing_ready", { disputedFromStatus: "billing_ready" })).toBe(
      true,
    );
  });

  it("disputed → an arbitrary status is illegal without the matching disputed_from_status", () => {
    expect(canTransition("disputed", "billing_ready")).toBe(false);
    expect(canTransition("disputed", "completed", { disputedFromStatus: "billing_ready" })).toBe(
      false,
    );
  });
});

describe("006 assignment transitions (canTransition reuses the single table)", () => {
  it("received → assigned is legal (assign)", () => {
    expect(canTransition("received", "assigned")).toBe(true);
  });

  it("assigned → confirmed is legal (confirm)", () => {
    expect(canTransition("assigned", "confirmed")).toBe(true);
  });

  it("assigned → received is legal (unassign — slice 015; was validated)", () => {
    expect(canTransition("assigned", "received")).toBe(true);
  });
});

describe("TRIP_CRITICAL_FIELDS (R9, FR-016)", () => {
  it("includes the planned windows, vehicle type, status, billing projection, and cancellation reason", () => {
    for (const field of [
      "plannedPickupWindowStart",
      "plannedPickupWindowEnd",
      "plannedDeliveryWindowStart",
      "plannedDeliveryWindowEnd",
      "plannedVehicleType",
      "currentStatus",
      "billingStatus",
      "cancellationReasonCode",
    ]) {
      expect(TRIP_CRITICAL_FIELDS as readonly string[]).toContain(field);
    }
  });

  it("includes the feature 006 assignment reference fields", () => {
    for (const field of [
      "assignedDriverId",
      "assignedVehicleId",
      "assignedTrailerId",
      "assignedCarrierId",
    ]) {
      expect(TRIP_CRITICAL_FIELDS as readonly string[]).toContain(field);
    }
  });

  it("does NOT include non-critical descriptive fields (route notes, volume)", () => {
    expect(TRIP_CRITICAL_FIELDS as readonly string[]).not.toContain("plannedRouteNotes");
    expect(TRIP_CRITICAL_FIELDS as readonly string[]).not.toContain("plannedVolumeUnits");
  });
});

// ---------------------------------------------------------------------------
// US5 (T031) — billing-phase projection lives only in the single TRANSITIONS table
// ---------------------------------------------------------------------------

describe("billingStatus projection (US5, FR-013, SC-005)", () => {
  it("every billing-phase status projects to itself", () => {
    for (const s of BILLING_PHASE_STATUSES) {
      expect(billingStatus(s)).toBe(s);
    }
  });

  it("every non-billing status projects to null", () => {
    const billingPhase = new Set<TripStatus>(BILLING_PHASE_STATUSES);
    for (const s of TRIP_STATUSES) {
      if (!billingPhase.has(s)) {
        expect(billingStatus(s)).toBeNull();
      }
    }
  });

  it("the billing-phase transitions exist only within the single TRANSITIONS table (no second machine)", () => {
    // completed → billing_pending → billing_ready → billed is the tail of the ONE machine.
    expect(canTransition("completed", "billing_pending")).toBe(true);
    expect(canTransition("billing_pending", "billing_ready")).toBe(true);
    expect(canTransition("billing_ready", "billed")).toBe(true);
    // and gating predicates are NOT enforced here (deferred to 008) — these are pure data transitions.
  });
});

// ---------------------------------------------------------------------------
// 005 control-tower — active/operating set, edit-window guard, billing-filter mapping
// ---------------------------------------------------------------------------

describe("ACTIVE_TRIP_STATUSES / isActiveStatus (005 R4)", () => {
  it("has exactly the 10 non-terminal statuses (slice 015 removed the two validation states)", () => {
    expect(ACTIVE_TRIP_STATUSES).toHaveLength(10);
  });

  it("excludes every closed/terminal status (completed, billing_*, billed, cancelled, disputed)", () => {
    for (const s of [
      "completed",
      "billing_pending",
      "billing_ready",
      "billed",
      "cancelled",
      "disputed",
    ] as const) {
      expect((ACTIVE_TRIP_STATUSES as readonly string[]).includes(s)).toBe(false);
      expect(isActiveStatus(s)).toBe(false);
    }
  });

  it("isActiveStatus is true for each active status and false otherwise (partition of the 16)", () => {
    const active = new Set<TripStatus>(ACTIVE_TRIP_STATUSES);
    for (const s of TRIP_STATUSES) {
      expect(isActiveStatus(s)).toBe(active.has(s));
    }
  });
});

describe("NON_EDITABLE_TRIP_STATUSES / isNonEditableStatus (005 R11)", () => {
  it("is the exact complement of ACTIVE_TRIP_STATUSES (10 active + 6 non-editable = 16)", () => {
    expect(NON_EDITABLE_TRIP_STATUSES).toHaveLength(6);
    const active = new Set<TripStatus>(ACTIVE_TRIP_STATUSES);
    const nonEditable = new Set<TripStatus>(NON_EDITABLE_TRIP_STATUSES);
    // disjoint
    for (const s of nonEditable) expect(active.has(s)).toBe(false);
    // together they cover all 16
    expect(active.size + nonEditable.size).toBe(TRIP_STATUSES.length);
    for (const s of TRIP_STATUSES) expect(active.has(s) || nonEditable.has(s)).toBe(true);
  });

  it("blocks editing at/after completion (completed + billing phase + cancelled + disputed)", () => {
    for (const s of NON_EDITABLE_TRIP_STATUSES) {
      expect(isNonEditableStatus(s)).toBe(true);
    }
    expect(isNonEditableStatus("received")).toBe(false);
    expect(isNonEditableStatus("in_transit")).toBe(false);
  });
});

describe("billingStatusToStatuses (005 R3) — billing filter → concrete statuses", () => {
  it("each billing-phase value maps to exactly itself", () => {
    for (const s of BILLING_PHASE_STATUSES) {
      expect(billingStatusToStatuses(s)).toEqual([s]);
    }
  });

  it("null maps to the empty set (no rows)", () => {
    expect(billingStatusToStatuses(null)).toEqual([]);
  });

  it("round-trips with billingStatus for billing-phase statuses", () => {
    for (const s of BILLING_PHASE_STATUSES) {
      const projected: BillingStatus = billingStatus(s);
      expect(billingStatusToStatuses(projected)).toEqual([s]);
    }
  });
});
