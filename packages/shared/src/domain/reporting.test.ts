import { describe, expect, it } from "vitest";
import {
  billingPeriodMonths,
  customReportPeriod,
  defaultReportPeriod,
  resolveReportPeriod,
} from "./reporting";
import { reportFilterSchema } from "../schemas/report";
import { auditLogQuerySchema } from "../schemas/audit";

/**
 * Feature 009 — pure reporting helpers + the two new query schemas (no DB). Pins the default period to
 * the last completed calendar month in America/Sao_Paulo and the schema defaults/validation.
 */

describe("defaultReportPeriod", () => {
  it("returns the last completed calendar month in America/Sao_Paulo", () => {
    // Mid-June 2026 (UTC) → São Paulo is UTC-3, so the last completed month is May 2026.
    const p = defaultReportPeriod(new Date("2026-06-15T12:00:00.000Z"));
    expect(p.from).toBe("2026-05-01T03:00:00.000Z"); // 2026-05-01 00:00 BRT
    expect(p.to).toBe("2026-06-01T03:00:00.000Z"); // 2026-06-01 00:00 BRT (exclusive)
    expect(p.label).toBe("maio/2026");
  });

  it("rolls the year over correctly at the January boundary", () => {
    // Early January 2026 BRT → last completed month is December 2025.
    const p = defaultReportPeriod(new Date("2026-01-05T10:00:00.000Z"));
    expect(p.from).toBe("2025-12-01T03:00:00.000Z");
    expect(p.to).toBe("2026-01-01T03:00:00.000Z");
    expect(p.label).toBe("dezembro/2025");
  });

  it("anchors the month boundary to São Paulo, not UTC (no off-by-one near midnight BRT)", () => {
    // 2026-06-01 02:00Z is still 2026-05-31 23:00 BRT → the current month is still May, so the last
    // completed month is April.
    const p = defaultReportPeriod(new Date("2026-06-01T02:00:00.000Z"));
    expect(p.label).toBe("abril/2026");
  });
});

describe("customReportPeriod", () => {
  it("builds a half-open UTC range with `to` inclusive of its São Paulo day", () => {
    const p = customReportPeriod("2026-05-01", "2026-05-31");
    expect(p.from).toBe("2026-05-01T03:00:00.000Z");
    expect(p.to).toBe("2026-06-01T03:00:00.000Z"); // 2026-05-31 + 1 day, BRT midnight
    expect(p.label).toBe("01/05/2026 – 31/05/2026");
  });
});

describe("resolveReportPeriod", () => {
  it("uses a custom range when both from and to are present", () => {
    const p = resolveReportPeriod(
      { from: "2026-03-01", to: "2026-03-31" },
      new Date("2026-06-15T12:00:00.000Z"),
    );
    expect(p.label).toBe("01/03/2026 – 31/03/2026");
  });

  it("falls back to the default month when from/to are absent", () => {
    const p = resolveReportPeriod({}, new Date("2026-06-15T12:00:00.000Z"));
    expect(p.label).toBe("maio/2026");
  });
});

describe("billingPeriodMonths", () => {
  it("returns the single YYYY-MM for a one-month default period", () => {
    const p = defaultReportPeriod(new Date("2026-06-15T12:00:00.000Z"));
    expect(billingPeriodMonths(p)).toEqual(["2026-05"]);
  });

  it("returns every overlapped month for a multi-month custom range", () => {
    const p = customReportPeriod("2026-01-15", "2026-03-10");
    expect(billingPeriodMonths(p)).toEqual(["2026-01", "2026-02", "2026-03"]);
  });
});

describe("reportFilterSchema", () => {
  it("defaults groupBy to customer and leaves optional filters undefined", () => {
    const parsed = reportFilterSchema.parse({});
    expect(parsed.groupBy).toBe("customer");
    expect(parsed.customerId).toBeUndefined();
    expect(parsed.from).toBeUndefined();
  });

  it("accepts a lane grouping and valid filters", () => {
    const parsed = reportFilterSchema.parse({
      groupBy: "lane",
      customerId: "11111111-1111-1111-1111-111111111111",
      from: "2026-05-01",
      to: "2026-05-31",
    });
    expect(parsed.groupBy).toBe("lane");
    expect(parsed.from).toBe("2026-05-01");
  });

  it("rejects a non-uuid customer and a malformed date", () => {
    expect(() => reportFilterSchema.parse({ customerId: "nope" })).toThrow();
    expect(() => reportFilterSchema.parse({ from: "05/2026" })).toThrow();
    expect(() => reportFilterSchema.parse({ groupBy: "carrier" })).toThrow();
  });
});

describe("auditLogQuerySchema", () => {
  it("defaults limit/offset and leaves filters undefined", () => {
    const parsed = auditLogQuerySchema.parse({});
    expect(parsed.limit).toBe(50);
    expect(parsed.offset).toBe(0);
    expect(parsed.actorUserId).toBeUndefined();
  });

  it("coerces/bounds pagination and accepts a date-only (YYYY-MM-DD) from/to", () => {
    const parsed = auditLogQuerySchema.parse({
      limit: "100",
      offset: "10",
      from: "2026-05-01",
      to: "2026-05-31",
    });
    expect(parsed.limit).toBe(100);
    expect(parsed.offset).toBe(10);
    // SP calendar-day strings (resolved to BRT day boundaries server-side) — not raw instants.
    expect(parsed.from).toBe("2026-05-01");
    expect(parsed.to).toBe("2026-05-31");
  });

  it("rejects an over-max limit, a non-uuid actor, and a non-date-only from", () => {
    expect(() => auditLogQuerySchema.parse({ limit: "500" })).toThrow();
    expect(() => auditLogQuerySchema.parse({ actorUserId: "nope" })).toThrow();
    expect(() => auditLogQuerySchema.parse({ from: "2026-05-01T00:00:00Z" })).toThrow();
  });
});
