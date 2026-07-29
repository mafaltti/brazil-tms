import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  parsingRulesSchema,
  templateConfigSchema,
  type TemplateConfig,
} from "../schemas/import";
import { applyTemplate } from "./engine";
import { detectInFileCollisions } from "./matching";
import { normalizeDate, normalizeNumber } from "./normalize";

const CUSTOMER_ID = "11111111-1111-1111-1111-111111111111";

// A representative Shopee-ish template (DOCUMENTED-DEFAULT columns — real files are PRD §29 BLOCKED).
const template: TemplateConfig = templateConfigSchema.parse({
  customerId: CUSTOMER_ID,
  name: "Default",
  version: 1,
  fileType: "csv",
  columnMappings: [
    { source: "ID Viagem", target: "externalTripId" },
    { source: "Origem", target: "originCode" },
    { source: "Destino", target: "destinationCode" },
    { source: "Coleta", target: "plannedPickupWindowStart" },
    { source: "Volumes", target: "plannedVolumeUnits" },
  ],
  parsingRules: { dateFormats: ["dd/MM/yyyy HH:mm"] },
});

describe("applyTemplate (config-driven mapping)", () => {
  it("maps source columns to internal targets, coercing date and number cells", () => {
    const row = applyTemplate(
      {
        "ID Viagem": "ABC-123",
        Origem: "SP-CAJAMAR",
        Destino: "RJ-DUQUE",
        Coleta: "01/02/2026 08:00",
        Volumes: "120",
      },
      template,
    );

    expect(row.externalTripId).toBe("ABC-123");
    expect(row.originCode).toBe("SP-CAJAMAR");
    expect(row.destinationCode).toBe("RJ-DUQUE");
    expect(row.plannedVolumeUnits).toBe(120);

    const expectedUtc = DateTime.fromFormat("01/02/2026 08:00", "dd/MM/yyyy HH:mm", {
      zone: "America/Sao_Paulo",
    })
      .toUTC()
      .toISO();
    expect(row.plannedPickupWindowStart?.toISOString()).toBe(
      new Date(expectedUtc!).toISOString(),
    );
  });

  it("leaves unmapped targets null and treats blank cells as null", () => {
    const row = applyTemplate(
      {
        "ID Viagem": "ABC-123",
        Origem: "  ", // blank → null
        Destino: "RJ-DUQUE",
        Coleta: "", // blank → null
        Volumes: "5",
      },
      template,
    );

    expect(row.originCode).toBeNull(); // whitespace-only cell
    expect(row.plannedPickupWindowStart).toBeNull(); // empty cell
    // A target with no mapping at all stays null.
    expect(row.plannedWeightKg).toBeNull();
    expect(row.plannedDeliveryWindowStart).toBeNull();
    expect(row.plannedServiceRequirements).toBeNull();
  });

  it("trims string values", () => {
    const row = applyTemplate({ "ID Viagem": "  ABC-123  " }, template);
    expect(row.externalTripId).toBe("ABC-123");
  });
});

describe("normalizeDate (explicit Luxon parsing)", () => {
  const rules = parsingRulesSchema.parse({ dateFormats: ["dd/MM/yyyy HH:mm"] });

  it("parses dd/MM/yyyy HH:mm in America/Sao_Paulo to the correct UTC instant", () => {
    const result = normalizeDate("01/02/2026 08:00", rules);
    const expectedUtc = DateTime.fromFormat("01/02/2026 08:00", "dd/MM/yyyy HH:mm", {
      zone: "America/Sao_Paulo",
    })
      .toUTC()
      .toISO();
    expect(result.toISOString()).toBe(new Date(expectedUtc!).toISOString());
  });

  it("throws on a garbage / ambiguous value", () => {
    expect(() => normalizeDate("not-a-date", rules)).toThrow(/UNPARSEABLE_DATE/);
    expect(() => normalizeDate("2026-02-01", rules)).toThrow(/UNPARSEABLE_DATE/); // wrong format
  });

  it("throws when dateFormats is empty (no implicit Date fallback)", () => {
    const emptyRules = parsingRulesSchema.parse({});
    expect(() => normalizeDate("01/02/2026 08:00", emptyRules)).toThrow(/UNPARSEABLE_DATE/);
  });
});

describe("normalizeNumber (separator-aware)", () => {
  const rules = parsingRulesSchema.parse({}); // decimal ",", thousand "."

  it("honors decimal ',' and thousand '.' (1.234,56 → 1234.56)", () => {
    expect(normalizeNumber("1.234,56", rules)).toBe(1234.56);
    expect(normalizeNumber("120", rules)).toBe(120);
    expect(normalizeNumber("0,5", rules)).toBe(0.5);
    expect(normalizeNumber("1.000.000", rules)).toBe(1000000);
  });

  it("throws on a non-numeric value", () => {
    expect(() => normalizeNumber("abc", rules)).toThrow(/UNPARSEABLE_NUMBER/);
  });
});

describe("detectInFileCollisions", () => {
  it("returns the row numbers sharing an externalTripId (case-insensitive)", () => {
    const collisions = detectInFileCollisions([
      { rowNumber: 1, externalTripId: "ABC" },
      { rowNumber: 2, externalTripId: "abc" }, // collides with 1
      { rowNumber: 3, externalTripId: "XYZ" },
      { rowNumber: 4, externalTripId: "ABC" }, // collides with 1 and 2
    ]);
    expect(collisions).toEqual(new Set([1, 2, 4]));
  });

  it("returns an empty set when all ids are unique", () => {
    const collisions = detectInFileCollisions([
      { rowNumber: 1, externalTripId: "ABC" },
      { rowNumber: 2, externalTripId: "DEF" },
    ]);
    expect(collisions.size).toBe(0);
  });

  it("ignores null / empty ids (they never collide)", () => {
    const collisions = detectInFileCollisions([
      { rowNumber: 1, externalTripId: null },
      { rowNumber: 2, externalTripId: null },
      { rowNumber: 3, externalTripId: "  " },
      { rowNumber: 4, externalTripId: "" },
    ]);
    expect(collisions.size).toBe(0);
  });
});

describe("templateConfigSchema", () => {
  it("accepts a valid config", () => {
    expect(
      templateConfigSchema.safeParse({
        customerId: CUSTOMER_ID,
        name: "Default",
        version: 1,
        fileType: "csv",
        columnMappings: [{ source: "ID Viagem", target: "externalTripId" }],
        parsingRules: { dateFormats: ["dd/MM/yyyy HH:mm"] },
      }).success,
    ).toBe(true);
  });

  it("rejects empty columnMappings (.min(1))", () => {
    expect(
      templateConfigSchema.safeParse({
        customerId: CUSTOMER_ID,
        name: "Default",
        version: 1,
        fileType: "csv",
        columnMappings: [],
      }).success,
    ).toBe(false);
  });
});
