import { describe, expect, it } from "vitest";
import {
  assignTripSchema,
  checkAssignmentSchema,
  confirmAssignmentSchema,
} from "./trip-assignment";

/**
 * Unit tests for the feature 006 assignment Zod schemas (data-model.md §3 / research §11). Pure — no DB.
 * Pins the required fields, the nullable-optional trailer/carrier, the `expectedFromStatus` enum, and
 * the length caps (mirrors `transitionTripSchema`).
 */

const UUID = "11111111-1111-1111-1111-111111111111";

describe("assignTripSchema", () => {
  it("accepts driver + vehicle + expectedFromStatus (trailer/carrier optional)", () => {
    const res = assignTripSchema.safeParse({
      driverId: UUID,
      vehicleId: UUID,
      expectedFromStatus: "received",
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.trailerId).toBeUndefined();
      expect(res.data.carrierId).toBeUndefined();
    }
  });

  it("requires driverId and vehicleId", () => {
    expect(
      assignTripSchema.safeParse({ vehicleId: UUID, expectedFromStatus: "received" }).success,
    ).toBe(false);
    expect(
      assignTripSchema.safeParse({ driverId: UUID, expectedFromStatus: "received" }).success,
    ).toBe(false);
  });

  it("rejects a non-uuid driver/vehicle", () => {
    expect(
      assignTripSchema.safeParse({
        driverId: "nope",
        vehicleId: UUID,
        expectedFromStatus: "received",
      }).success,
    ).toBe(false);
  });

  it("treats a blank trailer/carrier as absent (nullable-optional)", () => {
    const res = assignTripSchema.safeParse({
      driverId: UUID,
      vehicleId: UUID,
      trailerId: "",
      carrierId: null,
      expectedFromStatus: "received",
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.trailerId).toBeUndefined();
      expect(res.data.carrierId).toBeUndefined();
    }
  });

  it("accepts a valid trailer/carrier uuid when provided", () => {
    const res = assignTripSchema.safeParse({
      driverId: UUID,
      vehicleId: UUID,
      trailerId: UUID,
      carrierId: UUID,
      expectedFromStatus: "assigned",
    });
    expect(res.success).toBe(true);
  });

  it("rejects an invalid expectedFromStatus", () => {
    expect(
      assignTripSchema.safeParse({ driverId: UUID, vehicleId: UUID, expectedFromStatus: "warning" })
        .success,
    ).toBe(false);
  });

  it("rejects notes / overrideReason over 2000 chars", () => {
    const long = "a".repeat(2001);
    expect(
      assignTripSchema.safeParse({
        driverId: UUID,
        vehicleId: UUID,
        expectedFromStatus: "received",
        notes: long,
      }).success,
    ).toBe(false);
    expect(
      assignTripSchema.safeParse({
        driverId: UUID,
        vehicleId: UUID,
        expectedFromStatus: "received",
        overrideReason: long,
      }).success,
    ).toBe(false);
  });

  it("rejects an empty/whitespace overrideReason", () => {
    expect(
      assignTripSchema.safeParse({
        driverId: UUID,
        vehicleId: UUID,
        expectedFromStatus: "received",
        overrideReason: "   ",
      }).success,
    ).toBe(false);
  });
});

describe("confirmAssignmentSchema", () => {
  it("requires expectedFromStatus; notes optional", () => {
    expect(confirmAssignmentSchema.safeParse({ expectedFromStatus: "assigned" }).success).toBe(
      true,
    );
    expect(confirmAssignmentSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an invalid expectedFromStatus and over-long notes", () => {
    expect(confirmAssignmentSchema.safeParse({ expectedFromStatus: "nope" }).success).toBe(false);
    expect(
      confirmAssignmentSchema.safeParse({ expectedFromStatus: "assigned", notes: "a".repeat(2001) })
        .success,
    ).toBe(false);
  });
});

describe("checkAssignmentSchema — candidate-only, all optional", () => {
  it("accepts an empty body", () => {
    expect(checkAssignmentSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a partial candidate set and treats blanks as absent", () => {
    const res = checkAssignmentSchema.safeParse({ driverId: UUID, vehicleId: "", carrierId: null });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.driverId).toBe(UUID);
      expect(res.data.vehicleId).toBeUndefined();
      expect(res.data.carrierId).toBeUndefined();
    }
  });

  it("rejects a non-uuid candidate", () => {
    expect(checkAssignmentSchema.safeParse({ driverId: "nope" }).success).toBe(false);
  });
});
