import { describe, expect, it } from "vitest";
import {
  canTransitionException,
  EXCEPTION_RESPONSIBLE_PARTIES,
  EXCEPTION_SEVERITIES,
  EXCEPTION_STATUSES,
  EXCEPTION_TRANSITIONS,
  REASON_CODE_CATEGORIES,
  type ExceptionStatus,
} from "./exceptions";

/**
 * Unit tests for the pure exception-lifecycle module (data-model §9.2). Covers every legal/illegal
 * transition edge (Open↔Monitoring; →Resolved/Cancelled; terminal no-reopen) and the const shapes
 * (the 5-value responsible-party set incl. force_majeure; the 12 EXC-004 categories). Pure — no DB.
 */

describe("exception const shapes", () => {
  it("EXCEPTION_STATUSES is the four lifecycle states", () => {
    expect(EXCEPTION_STATUSES).toEqual(["open", "monitoring", "resolved", "cancelled"]);
  });

  it("EXCEPTION_SEVERITIES is low|medium|high (high = the SLA/alert trigger)", () => {
    expect(EXCEPTION_SEVERITIES).toEqual(["low", "medium", "high"]);
  });

  it("EXCEPTION_RESPONSIBLE_PARTIES is the 5-value set INCLUDING force_majeure", () => {
    expect(EXCEPTION_RESPONSIBLE_PARTIES).toHaveLength(5);
    expect(EXCEPTION_RESPONSIBLE_PARTIES).toContain("force_majeure");
    expect(EXCEPTION_RESPONSIBLE_PARTIES).toEqual([
      "customer_caused",
      "brazil_transports_caused",
      "carrier_caused",
      "force_majeure",
      "unknown",
    ]);
  });

  it("REASON_CODE_CATEGORIES is the 12 EXC-004 values", () => {
    expect(REASON_CODE_CATEGORIES).toHaveLength(12);
    expect(new Set(REASON_CODE_CATEGORIES).size).toBe(12);
    expect(REASON_CODE_CATEGORIES).toContain("documentation");
    expect(REASON_CODE_CATEGORIES).toContain("other");
  });
});

describe("canTransitionException — legal edges", () => {
  const legal: [ExceptionStatus, ExceptionStatus][] = [
    ["open", "monitoring"],
    ["open", "resolved"],
    ["open", "cancelled"],
    ["monitoring", "open"],
    ["monitoring", "resolved"],
    ["monitoring", "cancelled"],
  ];
  for (const [from, to] of legal) {
    it(`${from} → ${to} is legal`, () => {
      expect(canTransitionException(from, to)).toBe(true);
    });
  }
});

describe("canTransitionException — illegal edges", () => {
  it("Resolved and Cancelled are terminal (no reopen, no any-target)", () => {
    for (const to of EXCEPTION_STATUSES) {
      expect(canTransitionException("resolved", to)).toBe(false);
      expect(canTransitionException("cancelled", to)).toBe(false);
    }
  });

  it("no self-transition (open→open / monitoring→monitoring)", () => {
    expect(canTransitionException("open", "open")).toBe(false);
    expect(canTransitionException("monitoring", "monitoring")).toBe(false);
  });

  it("the transition map matches canTransitionException for every pair", () => {
    for (const from of EXCEPTION_STATUSES) {
      for (const to of EXCEPTION_STATUSES) {
        expect(canTransitionException(from, to)).toBe(EXCEPTION_TRANSITIONS[from].includes(to));
      }
    }
  });
});
