import { describe, expect, it } from "vitest";
import {
  TRIP_BOARD_DEFAULT_LIMIT,
  tripBoardQueryFromParams,
  tripBoardQuerySchema,
  tripExportQuerySchema,
} from "./trip-board";
import { updateTripPlanSchema } from "./trip";

/**
 * Unit tests for the 005 board query schema (filter whitelist / pagination bounds / scope default) and
 * the tightened plan-edit boundary schema (≥1 field, window start ≤ end). Pure — no DB.
 */

const UUID_A = "11111111-1111-1111-1111-111111111111";
const UUID_B = "22222222-2222-2222-2222-222222222222";

describe("tripBoardQuerySchema — defaults", () => {
  it("applies active scope, pickupStart asc, and 50/0 pagination when nothing is supplied", () => {
    const q = tripBoardQuerySchema.parse({});
    expect(q.scope).toBe("active");
    expect(q.sort).toBe("pickupStart");
    expect(q.dir).toBe("asc");
    expect(q.limit).toBe(TRIP_BOARD_DEFAULT_LIMIT);
    expect(q.offset).toBe(0);
    expect(q.status).toBeUndefined();
  });
});

describe("tripBoardQuerySchema — filters", () => {
  it("accepts the data-backed filters and normalizes status to an array", () => {
    const q = tripBoardQuerySchema.parse({
      customerId: UUID_A,
      status: "in_transit",
      billingStatus: "billing_pending",
      originLocationId: UUID_A,
      destinationLocationId: UUID_B,
      laneId: UUID_A,
      vehicleType: "truck",
      pickupFrom: "2026-05-01",
      pickupTo: "2026-05-31",
      q: "  SHP-123  ",
    });
    expect(q.status).toEqual(["in_transit"]);
    expect(q.billingStatus).toBe("billing_pending");
    expect(q.vehicleType).toBe("truck");
    expect(q.pickupFrom).toBe("2026-05-01");
    expect(q.q).toBe("SHP-123"); // trimmed
  });

  it("rejects an unknown sort key", () => {
    expect(tripBoardQuerySchema.safeParse({ sort: "totalCost" }).success).toBe(false);
  });

  it("rejects an invalid status / vehicle type / date / scope", () => {
    expect(tripBoardQuerySchema.safeParse({ status: "warning" }).success).toBe(false);
    expect(tripBoardQuerySchema.safeParse({ vehicleType: "spaceship" }).success).toBe(false);
    expect(tripBoardQuerySchema.safeParse({ pickupFrom: "05/2026" }).success).toBe(false);
    expect(tripBoardQuerySchema.safeParse({ scope: "archived" }).success).toBe(false);
    expect(tripBoardQuerySchema.safeParse({ customerId: "not-a-uuid" }).success).toBe(false);
  });

  it("treats a blank q / customerId as absent", () => {
    const q = tripBoardQuerySchema.parse({ q: "   ", customerId: "" });
    expect(q.q).toBeUndefined();
    expect(q.customerId).toBeUndefined();
  });
});

describe("tripBoardQuerySchema — pagination bounds", () => {
  it("coerces numeric strings and enforces 1..200", () => {
    expect(tripBoardQuerySchema.parse({ limit: "200", offset: "40" }).limit).toBe(200);
    expect(tripBoardQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(tripBoardQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
    expect(tripBoardQuerySchema.safeParse({ offset: "-1" }).success).toBe(false);
  });
});

describe("tripBoardQueryFromParams — URL search params", () => {
  it("reads repeated status params and applies defaults", () => {
    const params = new URLSearchParams();
    params.append("status", "assigned");
    params.append("status", "in_transit");
    params.set("q", "DHL");
    const q = tripBoardQueryFromParams(params);
    expect(q.status).toEqual(["assigned", "in_transit"]);
    expect(q.q).toBe("DHL");
    expect(q.scope).toBe("active");
  });
});

describe("tripBoardQuerySchema — 006 assignment filters", () => {
  it("accepts assigned true/false and driver/vehicle/carrier ids", () => {
    const q = tripBoardQuerySchema.parse({
      assigned: "false",
      driverId: UUID_A,
      vehicleId: UUID_B,
      carrierId: UUID_A,
    });
    expect(q.assigned).toBe("false");
    expect(q.driverId).toBe(UUID_A);
    expect(q.vehicleId).toBe(UUID_B);
    expect(q.carrierId).toBe(UUID_A);
  });

  it("rejects an invalid assigned value or a non-uuid resource filter", () => {
    expect(tripBoardQuerySchema.safeParse({ assigned: "maybe" }).success).toBe(false);
    expect(tripBoardQuerySchema.safeParse({ driverId: "not-a-uuid" }).success).toBe(false);
  });

  it("treats a blank assigned/driverId as absent", () => {
    const q = tripBoardQuerySchema.parse({ assigned: "", driverId: "" });
    expect(q.assigned).toBeUndefined();
    expect(q.driverId).toBeUndefined();
  });
});

describe("tripBoardQueryFromParams — 006 assignment filters round-trip via PARAM_KEYS", () => {
  it("reads assigned / driverId / vehicleId / carrierId from URL search params", () => {
    const params = new URLSearchParams();
    params.set("assigned", "true");
    params.set("driverId", UUID_A);
    params.set("vehicleId", UUID_B);
    params.set("carrierId", UUID_A);
    const q = tripBoardQueryFromParams(params);
    expect(q.assigned).toBe("true");
    expect(q.driverId).toBe(UUID_A);
    expect(q.vehicleId).toBe(UUID_B);
    expect(q.carrierId).toBe(UUID_A);
  });
});

describe("tripBoardQuerySchema — 007 SLA filters", () => {
  it("accepts slaStatus (one or many) and atRisk true/false", () => {
    const q = tripBoardQuerySchema.parse({ slaStatus: "at_risk", atRisk: "true" });
    expect(q.slaStatus).toEqual(["at_risk"]);
    expect(q.atRisk).toBe("true");
  });

  it("rejects an unknown sla status / atRisk value", () => {
    expect(tripBoardQuerySchema.safeParse({ slaStatus: "exploded" }).success).toBe(false);
    expect(tripBoardQuerySchema.safeParse({ atRisk: "maybe" }).success).toBe(false);
  });
});

describe("tripBoardQueryFromParams — 007 SLA filters round-trip via PARAM_KEYS", () => {
  it("reads repeated slaStatus + atRisk from URL search params", () => {
    const params = new URLSearchParams();
    params.append("slaStatus", "at_risk");
    params.append("slaStatus", "late");
    params.set("atRisk", "true");
    const q = tripBoardQueryFromParams(params);
    expect(q.slaStatus).toEqual(["at_risk", "late"]);
    expect(q.atRisk).toBe("true");
  });
});

describe("tripBoardQuerySchema — 008 missingDocuments filter", () => {
  it("accepts missingDocuments true/false and rejects an invalid value", () => {
    expect(tripBoardQuerySchema.parse({ missingDocuments: "true" }).missingDocuments).toBe("true");
    expect(tripBoardQuerySchema.safeParse({ missingDocuments: "maybe" }).success).toBe(false);
  });

  it("treats a blank missingDocuments as absent", () => {
    expect(tripBoardQuerySchema.parse({ missingDocuments: "" }).missingDocuments).toBeUndefined();
  });
});

describe("tripBoardQueryFromParams — 008 missingDocuments round-trip via PARAM_KEYS", () => {
  it("reads missingDocuments from URL search params", () => {
    const params = new URLSearchParams();
    params.set("missingDocuments", "true");
    expect(tripBoardQueryFromParams(params).missingDocuments).toBe("true");
  });
});

describe("tripExportQuerySchema — no pagination", () => {
  it("parses the same filters but strips limit/offset", () => {
    const q = tripExportQuerySchema.parse({ status: "in_transit", limit: "9999", offset: "5" });
    expect(q.status).toEqual(["in_transit"]);
    expect("limit" in q).toBe(false);
    expect("offset" in q).toBe(false);
  });
});

describe("updateTripPlanSchema — 005 tightening (≥1 field, window start ≤ end)", () => {
  it("rejects an empty edit", () => {
    expect(updateTripPlanSchema.safeParse({}).success).toBe(false);
    expect(updateTripPlanSchema.safeParse({ authorizedReview: true }).success).toBe(false);
  });

  it("accepts a single-field edit", () => {
    expect(updateTripPlanSchema.safeParse({ plannedRouteNotes: "remarcado" }).success).toBe(true);
  });

  it("rejects a pickup window whose start is after its end", () => {
    const res = updateTripPlanSchema.safeParse({
      plannedPickupWindowStart: "2026-05-10T12:00:00.000Z",
      plannedPickupWindowEnd: "2026-05-10T08:00:00.000Z",
    });
    expect(res.success).toBe(false);
  });

  it("accepts a well-ordered delivery window", () => {
    const res = updateTripPlanSchema.safeParse({
      plannedDeliveryWindowStart: "2026-05-10T08:00:00.000Z",
      plannedDeliveryWindowEnd: "2026-05-10T12:00:00.000Z",
    });
    expect(res.success).toBe(true);
  });
});
