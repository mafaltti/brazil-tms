import { DateTime } from "luxon";
import { APP_TIME_ZONE } from "@brazil-tms/shared";

/**
 * Default Control Tower board views (feature 005). Each view is a named preset that produces a flat
 * string map suitable for `URLSearchParams` / `useTripBoardFilters().setFilters`. `labelKey` is an
 * i18n key under `Trips.board` (e.g. `"viewToday"`). Plain in-memory array — no persistence, no
 * server-only dependency (importable by client components).
 *
 * EXTENSIBLE REGISTRY: later slices append their own views once their filter dimensions exist —
 * 006 → "Unassigned" (assigned driver/vehicle/carrier), 007 → "At risk" (SLA-risk), 008 →
 * "Missing documents". Those are NOT added here (their backing filters/indexes do not exist yet);
 * keep this array as the single place to register new presets.
 */
export interface TripBoardView {
  key: string;
  /** i18n key under `Trips.board`. */
  labelKey: string;
  /**
   * Flat string map of board params, MERGED into the current URL by `setFilters` (which treats an
   * empty-string value as "clear this key"). A preset must therefore clear any key that is mutually
   * exclusive with what it sets — `status` and `billingStatus` both constrain `current_status` and
   * compose with AND, so a status preset clears `billingStatus` and vice-versa (otherwise a leftover
   * value intersects to an empty board).
   */
  params: () => Record<string, string>;
}

/** Today (BRT), as `yyyy-MM-dd`. */
function today(): string {
  return DateTime.now().setZone(APP_TIME_ZONE).toISODate() ?? "";
}

/** Tomorrow (BRT), as `yyyy-MM-dd`. */
function tomorrow(): string {
  return DateTime.now().setZone(APP_TIME_ZONE).plus({ days: 1 }).toISODate() ?? "";
}

export const DEFAULT_TRIP_VIEWS: TripBoardView[] = [
  {
    key: "today",
    labelKey: "viewToday",
    params: () => ({ pickupFrom: today(), pickupTo: today(), scope: "all" }),
  },
  {
    key: "next24h",
    labelKey: "viewNext24h",
    params: () => ({ pickupFrom: today(), pickupTo: tomorrow(), scope: "all" }),
  },
  {
    key: "inTransit",
    labelKey: "viewInTransit",
    // Clear billingStatus: under AND it would intersect to an empty board with an in_transit status.
    params: () => ({ status: "in_transit", billingStatus: "", scope: "all" }),
  },
  {
    key: "billingPending",
    labelKey: "viewBillingPending",
    // Clear status: under AND a leftover status would intersect to an empty board with billing_pending.
    params: () => ({ billingStatus: "billing_pending", status: "", scope: "all" }),
  },
  {
    // 006 — active trips with no current assignment (the Dispatch Board's primary lens).
    key: "unassigned",
    labelKey: "viewUnassigned",
    // Clear status/billingStatus AND driverId/vehicleId/carrierId: setFilters MERGES into the current
    // URL, and `assigned=false` (no current assignment) is mutually exclusive with any resource filter
    // (`assigned=false` ⇒ the joined assignment id IS NULL, so driverId/vehicleId/carrierId can never
    // match) — a leftover resource filter would intersect to an empty board.
    params: () => ({
      assigned: "false",
      scope: "active",
      sort: "pickupStart",
      status: "",
      billingStatus: "",
      driverId: "",
      vehicleId: "",
      carrierId: "",
    }),
  },
  {
    // 007 — active trips at SLA risk (at_risk|late|breached). `atRisk=true` is the union shorthand;
    // clear status/billingStatus/slaStatus so a leftover filter cannot intersect to an empty board.
    key: "atRisk",
    labelKey: "viewAtRisk",
    params: () => ({
      atRisk: "true",
      scope: "active",
      sort: "pickupStart",
      status: "",
      billingStatus: "",
      slaStatus: "",
    }),
  },
  {
    // 008 — billing-phase trips with an unmet required-for-billing document. `missingDocuments=true`
    // itself constrains current_status to the billing phase (it suppresses the active-scope default),
    // so clear status/billingStatus/slaStatus to avoid a leftover filter intersecting to an empty board.
    key: "missingDocuments",
    labelKey: "viewMissingDocuments",
    params: () => ({
      missingDocuments: "true",
      scope: "active",
      sort: "pickupStart",
      status: "",
      billingStatus: "",
      slaStatus: "",
    }),
  },
];
