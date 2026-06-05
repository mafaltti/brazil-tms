import { DateTime } from "luxon";
import type { ParsingRules } from "../schemas/import";

/**
 * EXPLICIT value normalization for the import engine (research.md R5; STACK §3.5).
 *
 * Implicit JS date parsing (`new Date(value)` / `Date.parse`) is FORBIDDEN: it is locale/runtime
 * dependent and silently accepts ambiguous input. Every date is parsed against each configured
 * Luxon format in the template's zone; anything ambiguous or unparseable THROWS so the worker can
 * mark the row `error` (it catches and records the reason). Pure, no I/O.
 */

/** Escape a separator so it can be used literally inside a RegExp (e.g. "." or "$"). */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse a raw cell into a UTC instant. Trims first; empty or no-match throws. Two recognized shapes,
 * tried in order — both interpret a zone-less wall-clock in the template timezone (so "01/02/2026
 * 08:00" in America/Sao_Paulo yields the correct UTC instant) and store a UTC JS Date:
 *
 *  1. The template's configured Luxon formats — the CSV path: the operator-typed text format the cells
 *     literally hold (e.g. "dd/MM/yyyy HH:mm").
 *  2. An ISO-8601 *datetime* fallback (value contains a 'T'). xlsx typed date cells carry NO format —
 *     ExcelJS hands them back as JS `Date`s and the worker's `cellToString` emits a canonical ISO
 *     datetime. A ZONE-LESS ISO ("2026-06-07T15:00:00.000") is interpreted in the template timezone, so
 *     the wall-clock the user sees in Excel keeps its meaning; an ISO carrying an explicit offset/`Z`
 *     is honored as an absolute instant. ISO-8601 is unambiguous, so this stays within the "explicit,
 *     never an implicit `new Date()`" contract — a bare date with no time (no 'T') still throws.
 */
export function normalizeDate(value: string, rules: ParsingRules): Date {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error(`UNPARSEABLE_DATE: ${value}`);
  }
  for (const fmt of rules.dateFormats) {
    const dt = DateTime.fromFormat(trimmed, fmt, { zone: rules.timezone });
    if (dt.isValid) {
      return dt.toUTC().toJSDate();
    }
  }
  if (trimmed.includes("T")) {
    const iso = DateTime.fromISO(trimmed, { zone: rules.timezone });
    if (iso.isValid) {
      return iso.toUTC().toJSDate();
    }
  }
  // No configured format matched and not an ISO datetime. Never fall back to implicit parsing.
  throw new Error(`UNPARSEABLE_DATE: ${value}`);
}

/**
 * Parse a raw cell into a number honoring the template's thousand/decimal separators
 * (e.g. "1.234,56" with thousand "." and decimal "," → 1234.56). Strips thousand separators,
 * swaps the decimal separator for ".", then asserts a strict numeric shape before `Number(...)`.
 * Anything else throws.
 */
export function normalizeNumber(value: string, rules: ParsingRules): number {
  let s = value.trim();
  if (rules.thousandSeparator !== "") {
    s = s.replace(new RegExp(escapeRegExp(rules.thousandSeparator), "g"), "");
  }
  if (rules.decimalSeparator !== "") {
    s = s.replace(new RegExp(escapeRegExp(rules.decimalSeparator), "g"), ".");
  }
  if (!/^[-+]?\d*\.?\d+$/.test(s)) {
    throw new Error(`UNPARSEABLE_NUMBER: ${value}`);
  }
  return Number(s);
}
