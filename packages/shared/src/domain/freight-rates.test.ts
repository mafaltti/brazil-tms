import { describe, expect, it } from "vitest";
import {
  FREIGHT_SHEET_HEADER,
  normalizeFreightSheet,
  normalizeText,
  parsePriceCents,
} from "./freight-rates";

const HEADER = [...FREIGHT_SHEET_HEADER];

/** Synthetic sheet builder — never real freight data (spec FR-009). */
function sheet(...dataRows: unknown[][]): unknown[][] {
  return [HEADER, ...dataRows];
}

describe("parsePriceCents", () => {
  it("parses pt-BR formatted money", () => {
    expect(parsePriceCents("R$ 1.300,00")).toBe(130000);
    expect(parsePriceCents("R$ 1.799,50")).toBe(179950);
    expect(parsePriceCents("R$ 10.500,00")).toBe(1050000);
    expect(parsePriceCents("R$1.050")).toBe(105000);
  });

  it("parses plain numeric cells as reais", () => {
    expect(parsePriceCents(650)).toBe(65000);
    expect(parsePriceCents(650.5)).toBe(65050);
    expect(parsePriceCents("650.0")).toBe(65000);
    expect(parsePriceCents("1200")).toBe(120000);
  });

  it("treats '-', empty and nullish as no price", () => {
    expect(parsePriceCents("-")).toBeNull();
    expect(parsePriceCents("")).toBeNull();
    expect(parsePriceCents("  ")).toBeNull();
    expect(parsePriceCents(null)).toBeNull();
    expect(parsePriceCents(undefined)).toBeNull();
  });

  it("rejects garbage", () => {
    expect(parsePriceCents("ATÉ R$1200 depende")).toBeUndefined();
    expect(parsePriceCents("abc")).toBeUndefined();
  });
});

describe("normalizeText", () => {
  it("is accent- and case-insensitive", () => {
    expect(normalizeText("SÃO EXEMPLO")).toBe("sao exemplo");
    expect(normalizeText("  Cidade Á ")).toBe("cidade a");
  });
});

describe("normalizeFreightSheet", () => {
  it("normalizes groups with fill-down of origin/destination/km only", () => {
    const result = normalizeFreightSheet(
      sheet(
        ["AA", "CIDADE ALFA", "BB", "CIDADE BETA", "100.0", "CARRETA", "R$ 1.000,00", "-", "nota carreta"],
        ["", "", "", "", "", "TRUCK", "800", "-", ""],
        ["", "", "", "", "", "TOCO", "-", "-", ""],
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routeCount).toBe(1);
    expect(result.rates).toHaveLength(3);
    const [carreta, truck, toco] = result.rates;
    if (!carreta || !truck || !toco) throw new Error("expected 3 rates");
    // fill-down of route fields + km
    expect(truck.originCity).toBe("CIDADE ALFA");
    expect(toco.destinationCity).toBe("CIDADE BETA");
    expect(truck.km).toBe(100);
    // observações is per-row: only the CARRETA row has it
    expect(carreta.observacoes).toBe("nota carreta");
    expect(truck.observacoes).toBeNull();
    expect(toco.observacoes).toBeNull();
    // prices
    expect(carreta.valorIdaCents).toBe(100000);
    expect(truck.valorIdaCents).toBe(80000);
    expect(toco.valorIdaCents).toBeNull();
  });

  it("uppercases UFs and vehicle labels; trims cities", () => {
    const result = normalizeFreightSheet(
      sheet(["aa", " Cidade Alfa ", "bb", "CIDADE BETA", "", "carreta", "-", "-", ""]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rates[0]?.originUf).toBe("AA");
    expect(result.rates[0]?.vehicleType).toBe("CARRETA");
    expect(result.rates[0]?.originCity).toBe("Cidade Alfa");
    expect(result.rates[0]?.km).toBeNull();
  });

  it("ignores trailing empty columns and blank rows", () => {
    const rows = sheet(
      ["AA", "CIDADE ALFA", "BB", "CIDADE BETA", "10", "CARRETA", "100", "-", "", "", "", ""],
      ["", "", "", "", "", "", "", "", ""],
    );
    rows[0] = [...HEADER, "", "", ""];
    const result = normalizeFreightSheet(rows);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rates).toHaveLength(1);
  });

  it("rejects a wrong header naming the column", () => {
    const bad = sheet(["AA", "CIDADE ALFA", "BB", "CIDADE BETA", "", "CARRETA", "-", "-", ""]);
    bad[0] = ["UF Origem", "Cidade", ...HEADER.slice(2)];
    const result = normalizeFreightSheet(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.row).toBe(1);
    expect(result.issues[0]?.column).toBe("Cidade Origem");
  });

  it("rejects a file starting with a continuation row", () => {
    const result = normalizeFreightSheet(
      sheet(["", "", "", "", "", "TRUCK", "100", "-", ""]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.row).toBe(2);
  });

  it("rejects duplicate route + vehicle type pointing at both rows", () => {
    const result = normalizeFreightSheet(
      sheet(
        ["AA", "CIDADE ALFA", "BB", "CIDADE BETA", "10", "CARRETA", "100", "-", ""],
        ["AA", "CIDADE ALFA", "BB", "CIDADE BETA", "10", "CARRETA", "200", "-", ""],
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain("linha 2");
    expect(result.issues[0]?.row).toBe(3);
  });

  it("collects row/column errors for invalid UF, km and prices", () => {
    const result = normalizeFreightSheet(
      sheet(["SP1", "CIDADE ALFA", "BB", "CIDADE BETA", "abc", "CARRETA", "talvez", "-", ""]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const columns = result.issues.map((issue) => issue.column);
    expect(columns).toContain("UF Origem");
    expect(columns).toContain("Km");
    expect(columns).toContain("Valor Ida");
  });

  it("rejects an empty grid and a data-less sheet", () => {
    expect(normalizeFreightSheet([]).ok).toBe(false);
    expect(normalizeFreightSheet([HEADER]).ok).toBe(false);
  });
});
