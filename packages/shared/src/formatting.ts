import { DateTime } from "luxon";

/** Canonical display timezone for the product (PRD §21.6 / STACK §3.5). */
export const APP_TIME_ZONE = "America/Sao_Paulo";
export const APP_LOCALE = "pt-BR";

const EMPTY = "—";

function toDateTime(value: string | Date): DateTime {
  // Parse ISO strings IN the app zone so a date-only value ("YYYY-MM-DD") is anchored to São Paulo
  // midnight rather than the server's default zone. Without this, a UTC-default server shifts
  // date-only DB values back a day (e.g. 2026-05-29 → 28/05) and skews the expiry window. Strings
  // carrying an explicit offset/Z keep their instant and are converted to the app zone.
  return value instanceof Date
    ? DateTime.fromJSDate(value)
    : DateTime.fromISO(value, { zone: APP_TIME_ZONE });
}

/** Parse a UTC value and shift it into the app timezone (America/Sao_Paulo). */
export function fromUtc(value: string | Date): DateTime {
  return toDateTime(value).setZone(APP_TIME_ZONE);
}

/** dd/MM/yyyy in America/Sao_Paulo, or an em dash for null/invalid input. */
export function formatDate(value: string | Date | null | undefined): string {
  if (value == null) return EMPTY;
  const dt = fromUtc(value);
  return dt.isValid ? dt.toFormat("dd/MM/yyyy") : EMPTY;
}

/** dd/MM/yyyy HH:mm in America/Sao_Paulo, or an em dash for null/invalid input. */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (value == null) return EMPTY;
  const dt = fromUtc(value);
  return dt.isValid ? dt.toFormat("dd/MM/yyyy HH:mm") : EMPTY;
}

/** Localized relative time (e.g. "há 2 horas"), or an em dash for null/invalid input. */
export function formatRelative(value: string | Date | null | undefined): string {
  if (value == null) return EMPTY;
  const dt = fromUtc(value);
  return dt.isValid ? (dt.toRelative({ locale: APP_LOCALE }) ?? EMPTY) : EMPTY;
}

/** Convert a DateTime/Date to a UTC ISO 8601 string for storage. */
export function toUtcIso(value: DateTime | Date): string {
  const dt = value instanceof Date ? DateTime.fromJSDate(value) : value;
  return dt.toUTC().toISO() ?? "";
}

/**
 * The half-open UTC instant range `[from, to)` covering one calendar day in America/Sao_Paulo (005 R6).
 * `date` is a date-only string (`YYYY-MM-DD`, anchored to São Paulo midnight) or an instant whose São
 * Paulo calendar day is used. Used for date-range board filters, the Today / Next-24h views, and the
 * "trips today by status" dashboard count against UTC-stored `planned_pickup_window_start`. Computing
 * the boundary in the business timezone avoids the off-by-one-day bug near midnight BRT.
 */
export function dayRangeSaoPaulo(date: string | Date): { from: string; to: string } {
  const start = fromUtc(date).startOf("day");
  const end = start.plus({ days: 1 });
  return { from: start.toUTC().toISO() ?? "", to: end.toUTC().toISO() ?? "" };
}

/**
 * Format an integer amount of centavos as BRL currency (pt-BR).
 * Monetary amounts are stored as integer centavos; no money is displayed in feature 001 —
 * this helper exists for later features (FR-022).
 */
export function formatBRL(centavos: number): string {
  return new Intl.NumberFormat(APP_LOCALE, {
    style: "currency",
    currency: "BRL",
  }).format(centavos / 100);
}

/**
 * Default documentation-expiry warning window, in days (feature 002, Clarification Q5 / R9).
 * This is the SINGLE configuration source for the window — call sites must not hard-code a literal.
 */
export const DOCUMENT_EXPIRY_WARNING_DAYS = 30;

/** Derived documentation-expiry state for a resource (drivers/vehicles/trailers). */
export type DocumentExpiryState = "ok" | "expiring" | "expired";

/**
 * Pure helper deriving the documentation-expiry state from a date (R9). Never stored — recomputed on
 * read so it can never drift. `expired` = the expiry is on/before `now` (date-only, America/Sao_Paulo);
 * `expiring` = within `windowDays`; `ok` otherwise or when there is no expiry. Day-granular: only the
 * calendar date matters, so "today" counts as expired.
 */
export function documentExpiryState(
  expiry: string | Date | null | undefined,
  now: string | Date,
  windowDays: number = DOCUMENT_EXPIRY_WARNING_DAYS,
): DocumentExpiryState {
  if (expiry == null) return "ok";
  const expiryDate = toDateTime(expiry).setZone(APP_TIME_ZONE).startOf("day");
  if (!expiryDate.isValid) return "ok";
  const today = toDateTime(now).setZone(APP_TIME_ZONE).startOf("day");
  const days = expiryDate.diff(today, "days").days;
  if (days <= 0) return "expired";
  if (days <= windowDays) return "expiring";
  return "ok";
}
