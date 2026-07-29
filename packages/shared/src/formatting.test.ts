import { describe, expect, it } from "vitest";
import {
  DOCUMENT_EXPIRY_WARNING_DAYS,
  dayRangeSaoPaulo,
  documentExpiryState,
  formatBRL,
  formatDate,
} from "./formatting";

describe("documentExpiryState (R9)", () => {
  // Fixed "now" so the test is deterministic (no Date.now()).
  const now = "2026-05-29T12:00:00.000Z";

  it("returns 'ok' when there is no expiry date", () => {
    expect(documentExpiryState(null, now)).toBe("ok");
    expect(documentExpiryState(undefined, now)).toBe("ok");
  });

  it("returns 'expired' for a date in the past", () => {
    expect(documentExpiryState("2026-05-01", now)).toBe("expired");
  });

  it("counts today as 'expired' (day-granular, on/before now)", () => {
    expect(documentExpiryState("2026-05-29", now)).toBe("expired");
  });

  it("returns 'expiring' for a date within the default 30-day window", () => {
    expect(documentExpiryState("2026-06-10", now)).toBe("expiring");
    // Boundary: exactly the window edge is still 'expiring'.
    expect(documentExpiryState("2026-06-28", now)).toBe("expiring");
  });

  it("returns 'ok' for a date beyond the window", () => {
    expect(documentExpiryState("2026-08-01", now)).toBe("ok");
  });

  it("honors a custom window", () => {
    expect(documentExpiryState("2026-06-05", now, 3)).toBe("ok");
    expect(documentExpiryState("2026-06-01", now, 3)).toBe("expiring");
  });

  it("exposes the default window as the single config source", () => {
    expect(DOCUMENT_EXPIRY_WARNING_DAYS).toBe(30);
  });
});

describe("formatDate — date-only values are zone-stable (P2 fix)", () => {
  it("renders a date-only string as the same calendar date regardless of server zone", () => {
    // Without anchoring the parse to America/Sao_Paulo, a UTC-default server would render 28/05/2026.
    expect(formatDate("2026-05-29")).toBe("29/05/2026");
    expect(formatDate("2026-01-01")).toBe("01/01/2026");
  });

  it("still converts a UTC timestamp into the app zone", () => {
    // 2026-05-29T02:00Z is 28/05 23:00 in America/Sao_Paulo (-03:00).
    expect(formatDate("2026-05-29T02:00:00.000Z")).toBe("28/05/2026");
  });
});

describe("dayRangeSaoPaulo (R6) — BRT calendar day → half-open UTC range", () => {
  it("maps a date-only string to São Paulo midnight..midnight in UTC (−03:00)", () => {
    const { from, to } = dayRangeSaoPaulo("2026-05-29");
    expect(from).toBe("2026-05-29T03:00:00.000Z");
    expect(to).toBe("2026-05-30T03:00:00.000Z");
  });

  it("uses the São Paulo calendar day of an instant near midnight (not the UTC day)", () => {
    // 2026-05-29T02:00Z is 28/05 23:00 in America/Sao_Paulo → the BRT day is 2026-05-28.
    const { from, to } = dayRangeSaoPaulo(new Date("2026-05-29T02:00:00.000Z"));
    expect(from).toBe("2026-05-28T03:00:00.000Z");
    expect(to).toBe("2026-05-29T03:00:00.000Z");
  });

  it("produces a 24-hour half-open window", () => {
    const { from, to } = dayRangeSaoPaulo("2026-01-15");
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("formatBRL", () => {
  it("formats integer centavos as BRL", () => {
    // Non-breaking spaces in the Intl output — assert on the digits/symbol loosely.
    expect(formatBRL(123456)).toContain("1.234,56");
    expect(formatBRL(0)).toContain("0,00");
  });
});
