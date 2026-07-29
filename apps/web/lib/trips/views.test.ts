import { describe, expect, it } from "vitest";
import { DEFAULT_TRIP_VIEWS } from "./views";

/**
 * Unit test for the default board view presets (feature 005). Pure — no DB. Guards the regression
 * where, under AND `status`∩`billingStatus` filtering, a preset that sets only one of the two left a
 * stale value of the other in the URL and yielded an empty board.
 *
 * `applyView` mirrors `useTripBoardFilters().setFilters`' merge: each key is deleted, then re-set only
 * when its value is non-empty (an empty string clears the key).
 */
function applyView(current: string, params: Record<string, string>): URLSearchParams {
  const out = new URLSearchParams(current);
  for (const [key, value] of Object.entries(params)) {
    out.delete(key);
    if (value !== "") out.set(key, value);
  }
  return out;
}

function view(key: string) {
  const found = DEFAULT_TRIP_VIEWS.find((v) => v.key === key);
  if (!found) throw new Error(`no view ${key}`);
  return found;
}

describe("DEFAULT_TRIP_VIEWS — presets clear mutually-exclusive status/billing keys", () => {
  it("'In transit' over a lingering billingStatus clears billingStatus (no empty AND board)", () => {
    const result = applyView(
      "billingStatus=billing_pending&customerId=abc",
      view("inTransit").params(),
    );
    expect(result.get("status")).toBe("in_transit");
    expect(result.get("billingStatus")).toBeNull(); // cleared
    expect(result.get("customerId")).toBe("abc"); // orthogonal filter preserved
    expect(result.get("scope")).toBe("all");
  });

  it("'Billing pending' over a lingering status clears status", () => {
    const result = applyView("status=in_transit&status=assigned", view("billingPending").params());
    expect(result.get("billingStatus")).toBe("billing_pending");
    expect(result.getAll("status")).toEqual([]); // all status values cleared
    expect(result.get("scope")).toBe("all");
  });

  it("date presets set a pickup range + scope and do not introduce a status/billing conflict", () => {
    for (const key of ["today", "next24h"]) {
      const p = view(key).params();
      expect(p.pickupFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.pickupTo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.scope).toBe("all");
      expect(p.status).toBeUndefined();
      expect(p.billingStatus).toBeUndefined();
    }
  });

  // 006 — the "Unassigned" preset (the Dispatch Board's primary lens): active trips with no current
  // assignment, sorted by pickup. It must clear the mutually-exclusive status/billingStatus keys.
  it("'Unassigned' sets assigned=false / scope=active / sort=pickupStart and clears status + billingStatus + resource filters", () => {
    const p = view("unassigned").params();
    expect(p.assigned).toBe("false");
    expect(p.scope).toBe("active");
    expect(p.sort).toBe("pickupStart");
    // Clears the mutually-exclusive status constraints (empty string ⇒ "clear this key").
    expect(p.status).toBe("");
    expect(p.billingStatus).toBe("");
    // ...and the resource filters: `assigned=false` (no current assignment) is mutually exclusive with
    // any driverId/vehicleId/carrierId (they require a current assignment), so they must be cleared too.
    expect(p.driverId).toBe("");
    expect(p.vehicleId).toBe("");
    expect(p.carrierId).toBe("");
  });

  it("'Unassigned' applied over lingering status/billing/resource filters clears them all, keeps assigned/scope/sort", () => {
    const result = applyView(
      "status=in_transit&billingStatus=billing_pending&driverId=d1&vehicleId=v1&carrierId=c1&customerId=abc",
      view("unassigned").params(),
    );
    expect(result.get("assigned")).toBe("false");
    expect(result.get("scope")).toBe("active");
    expect(result.get("sort")).toBe("pickupStart");
    expect(result.getAll("status")).toEqual([]); // cleared
    expect(result.get("billingStatus")).toBeNull(); // cleared
    // The resource filters that would otherwise intersect `assigned=false` to an empty board:
    expect(result.get("driverId")).toBeNull();
    expect(result.get("vehicleId")).toBeNull();
    expect(result.get("carrierId")).toBeNull();
    expect(result.get("customerId")).toBe("abc"); // orthogonal filter preserved
  });
});
