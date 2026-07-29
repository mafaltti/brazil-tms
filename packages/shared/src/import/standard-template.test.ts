import { describe, expect, it } from "vitest";
import { templateConfigSchema } from "../schemas/import";
import { STANDARD_IMPORT_TEMPLATE } from "./standard-template";
import { inferFileType } from "./file-type";

/**
 * Slice 013 — guards the predefined standard format + the shared file-type rule. Pure unit (no DB):
 * a malformed edit of the in-code constant must fail here, not at parse time, and the one canonical
 * extension rule must agree across the BFF upload route and the parse worker.
 */
describe("STANDARD_IMPORT_TEMPLATE", () => {
  it("parses against templateConfigSchema (a malformed edit fails fast)", () => {
    expect(() => templateConfigSchema.parse(STANDARD_IMPORT_TEMPLATE)).not.toThrow();
  });

  it("adds no new required-column enforcement (requiredOverrides is empty, R8)", () => {
    expect(STANDARD_IMPORT_TEMPLATE.requiredOverrides).toEqual([]);
  });

  it("maps the documented demo headers to the internal trip fields", () => {
    const sources = STANDARD_IMPORT_TEMPLATE.columnMappings.map((m) => m.source);
    expect(sources).toEqual([
      "id_viagem",
      "origem",
      "destino",
      "janela_coleta_inicio",
      "janela_coleta_fim",
      "janela_entrega_inicio",
      "janela_entrega_fim",
      "tipo_veiculo",
      "status",
    ]);
  });
});

describe("inferFileType", () => {
  it("returns the supported type from the extension (case-insensitive)", () => {
    expect(inferFileType("trips.csv")).toBe("csv");
    expect(inferFileType("TRIPS.CSV")).toBe("csv");
    expect(inferFileType("trips.xlsx")).toBe("xlsx");
    expect(inferFileType("trips.XLSX")).toBe("xlsx");
  });

  it("returns null for an unsupported extension", () => {
    expect(inferFileType("trips.pdf")).toBeNull();
    expect(inferFileType("trips")).toBeNull();
  });
});
