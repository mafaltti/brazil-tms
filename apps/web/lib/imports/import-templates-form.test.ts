import { describe, expect, it } from "vitest";
import {
  deriveRequiredOverrides,
  findDuplicateTargets,
  hasDateTargetWithoutFormat,
  nextVersion,
} from "./import-templates-client";

/**
 * Unit tests for the UI-only validation helpers backing the import-template form (slice 012). These are
 * pure functions — the form's `.superRefine` and the non-blocking date warning delegate to them, and the
 * web Vitest project scans `lib/**` only, so the logic lives here to be unit-testable.
 */

describe("findDuplicateTargets", () => {
  it("flags two rows that share a target", () => {
    const dups = findDuplicateTargets([{ target: "originCode" }, { target: "originCode" }]);
    expect([...dups]).toEqual(["originCode"]);
  });

  it("returns nothing for all-unique targets", () => {
    const dups = findDuplicateTargets([
      { target: "originCode" },
      { target: "destinationCode" },
      { target: "externalTripId" },
    ]);
    expect(dups.size).toBe(0);
  });

  it("ignores empty targets (those are the separate base-schema incomplete-mapping error)", () => {
    const dups = findDuplicateTargets([{ target: "" }, { target: "  " }, { target: undefined }]);
    expect(dups.size).toBe(0);
  });

  it("handles N>2: ≥3 rows sharing a target are all flagged (single duplicated value returned)", () => {
    const rows = [
      { target: "statusLabel" },
      { target: "statusLabel" },
      { target: "statusLabel" },
      { target: "originCode" },
    ];
    const dups = findDuplicateTargets(rows);
    expect([...dups]).toEqual(["statusLabel"]);
    // every conflicting row's target is in the set, so the form flags all three
    expect(rows.filter((r) => r.target && dups.has(r.target))).toHaveLength(3);
  });
});

describe("nextVersion", () => {
  it("returns max(existing for that name) + 1", () => {
    const list = [
      { name: "Shopee", version: 1 },
      { name: "Shopee", version: 3 },
      { name: "Outro", version: 9 },
    ];
    expect(nextVersion(list, "Shopee")).toBe(4);
  });

  it("returns 1 when the name has no existing versions", () => {
    expect(nextVersion([{ name: "Outro", version: 2 }], "Novo")).toBe(1);
    expect(nextVersion([], "Qualquer")).toBe(1);
  });
});

describe("deriveRequiredOverrides", () => {
  it("collects the targets of rows flagged required (the only set the worker enforces)", () => {
    const overrides = deriveRequiredOverrides([
      { target: "externalTripId", required: true },
      { target: "originCode", required: false },
      { target: "destinationCode", required: true },
    ]);
    expect(overrides).toEqual(["externalTripId", "destinationCode"]);
  });

  it("ignores required rows with a blank/missing target and dedupes", () => {
    expect(
      deriveRequiredOverrides([
        { target: "", required: true },
        { target: "  ", required: true },
        { target: "originCode", required: true },
        { target: "originCode", required: true },
      ]),
    ).toEqual(["originCode"]);
  });

  it("returns [] when nothing is flagged required", () => {
    expect(
      deriveRequiredOverrides([
        { target: "externalTripId" },
        { target: "originCode", required: false },
      ]),
    ).toEqual([]);
  });
});

describe("hasDateTargetWithoutFormat", () => {
  it("is true when a date-kind target is mapped but dateFormats is empty", () => {
    expect(
      hasDateTargetWithoutFormat({
        columnMappings: [{ target: "plannedPickupWindowStart" }],
        parsingRules: { dateFormats: [] },
      }),
    ).toBe(true);
  });

  it("is false when a date format is present", () => {
    expect(
      hasDateTargetWithoutFormat({
        columnMappings: [{ target: "plannedPickupWindowStart" }],
        parsingRules: { dateFormats: ["dd/MM/yyyy HH:mm"] },
      }),
    ).toBe(false);
  });

  it("is false when no date-kind target is mapped", () => {
    expect(
      hasDateTargetWithoutFormat({
        columnMappings: [{ target: "originCode" }, { target: "plannedWeightKg" }],
        parsingRules: { dateFormats: [] },
      }),
    ).toBe(false);
  });

  it("treats whitespace-only date formats as empty", () => {
    expect(
      hasDateTargetWithoutFormat({
        columnMappings: [{ target: "plannedDeliveryWindowEnd" }],
        parsingRules: { dateFormats: ["   "] },
      }),
    ).toBe(true);
  });
});
