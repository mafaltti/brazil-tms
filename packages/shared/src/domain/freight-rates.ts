/**
 * Feature 016 — pure normalizer for the internal agregados freight sheet
 * (spec FR-005, data-model.md §Normalization invariants). No I/O: input is the raw
 * cell grid (exceljs → unknown[][] happens in the web layer), output is either the
 * normalized rate rows or pt-BR row/column errors. Kept pure so fill-down, price
 * parsing and duplicate rules are unit-testable without spreadsheet or DB (R6).
 */

/** Expected header of sheet "Controle de Fretes" (columns beyond the 9th are ignored). */
export const FREIGHT_SHEET_HEADER = [
  "UF Origem",
  "Cidade Origem",
  "UF Destino",
  "Cidade Destino",
  "Km",
  "Tipo Veículo",
  "Valor Ida",
  "Valor Reversa",
  "Observações",
] as const;

export const FREIGHT_SHEET_NAME = "Controle de Fretes";

export interface FreightRateRow {
  originUf: string;
  originCity: string;
  destinationUf: string;
  destinationCity: string;
  km: number | null;
  vehicleType: string;
  valorIdaCents: number | null;
  valorReversaCents: number | null;
  observacoes: string | null;
}

export interface FreightSheetIssue {
  /** 1-based row number as the user sees it in Excel (header = row 1). */
  row: number;
  column: string;
  message: string;
}

export type NormalizeFreightSheetResult =
  | { ok: true; rates: FreightRateRow[]; routeCount: number }
  | { ok: false; issues: FreightSheetIssue[] };

/** Accent-insensitive, case-insensitive comparison key (client combobox matching, R5). */
export function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Parse a sheet price cell into integer centavos (R4). Accepts pt-BR formatted
 * strings ("R$ 1.300,00", "R$ 1.799,50"), plain numeric cells/strings interpreted as
 * reais ("650", 650.0), and "-"/empty as null. Returns `undefined` when unparseable.
 */
export function parsePriceCents(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value * 100) : undefined;
  }
  const text = String(value).trim();
  if (text === "" || text === "-") return null;
  // pt-BR money: optional "R$", "." thousands, "," decimals.
  const brl = text.match(/^R?\$?\s*([\d.]+)(?:,(\d{1,2}))?$/);
  if (!brl) return undefined;
  const whole = brl[1] ?? "";
  const decimals = brl[2];
  if (decimals === undefined && /\.\d{1,2}$/.test(whole) && !text.startsWith("R")) {
    // Plain "650.5" style decimal (spreadsheet float rendered as string).
    const plain = Number(whole);
    return Number.isFinite(plain) ? Math.round(plain * 100) : undefined;
  }
  const wholeDigits = whole.replace(/\./g, "");
  if (!/^\d+$/.test(wholeDigits)) return undefined;
  let cents = Number(wholeDigits) * 100;
  if (decimals !== undefined) cents += Number(decimals.padEnd(2, "0"));
  return cents;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function isBlankRow(cells: readonly unknown[]): boolean {
  return cells.every((cell) => cellText(cell) === "" || cellText(cell) === "-");
}

function parseKm(value: unknown): number | null | undefined {
  const text = cellText(value);
  if (text === "" || text === "-") return null;
  const km = Number(text.replace(",", "."));
  if (!Number.isFinite(km) || km < 0) return undefined;
  return Math.round(km);
}

/**
 * Normalize the raw grid of sheet "Controle de Fretes".
 * Rules (data-model.md): header must match; fill-down applies ONLY to
 * origin/destination/km within a route group; Observações and Tipo Veículo are
 * per-row; first data row must start a group; duplicate (route, vehicle) rejects
 * the file; UFs must be 2 letters (uppercased); trailing empty columns/rows ignored.
 */
export function normalizeFreightSheet(
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): NormalizeFreightSheetResult {
  const issues: FreightSheetIssue[] = [];
  if (rows.length === 0) {
    return { ok: false, issues: [{ row: 1, column: "-", message: "Planilha vazia." }] };
  }

  const header = (rows[0] ?? []).slice(0, FREIGHT_SHEET_HEADER.length).map(cellText);
  FREIGHT_SHEET_HEADER.forEach((expected, i) => {
    if (normalizeText(header[i] ?? "") !== normalizeText(expected)) {
      issues.push({
        row: 1,
        column: expected,
        message: `Cabeçalho inesperado na coluna ${i + 1}: esperado "${expected}", encontrado "${header[i] ?? ""}".`,
      });
    }
  });
  if (issues.length > 0) return { ok: false, issues };

  const rates: FreightRateRow[] = [];
  const seen = new Map<string, number>();
  // Route count is derived from DISTINCT route keys (not group transitions) so the result is
  // identical whether the sheet leaves continuation cells blank or uses merged cells (which
  // exceljs propagates to every row of the merge).
  const routeKeys = new Set<string>();
  let group: {
    originUf: string;
    originCity: string;
    destinationUf: string;
    destinationCity: string;
    km: number | null;
  } | null = null;

  for (let i = 1; i < rows.length; i++) {
    const cells = (rows[i] ?? []).slice(0, FREIGHT_SHEET_HEADER.length);
    if (isBlankRow(cells)) continue;
    const rowNumber = i + 1;
    const [ufO, cidO, ufD, cidD, kmCell, tipo, ida, reversa, obs] = cells;

    if (cellText(ufO) !== "") {
      // New route group.
      const originUf = cellText(ufO).toUpperCase();
      const originCity = cellText(cidO);
      const destinationUf = cellText(ufD).toUpperCase();
      const destinationCity = cellText(cidD);
      if (!/^[A-Z]{2}$/.test(originUf)) {
        issues.push({ row: rowNumber, column: "UF Origem", message: `UF inválida: "${cellText(ufO)}".` });
      }
      if (!/^[A-Z]{2}$/.test(destinationUf)) {
        issues.push({ row: rowNumber, column: "UF Destino", message: `UF inválida: "${cellText(ufD)}".` });
      }
      if (originCity === "") {
        issues.push({ row: rowNumber, column: "Cidade Origem", message: "Cidade de origem obrigatória." });
      }
      if (destinationCity === "") {
        issues.push({ row: rowNumber, column: "Cidade Destino", message: "Cidade de destino obrigatória." });
      }
      const km = parseKm(kmCell);
      if (km === undefined) {
        issues.push({ row: rowNumber, column: "Km", message: `Km inválido: "${cellText(kmCell)}".` });
      }
      group = { originUf, originCity, destinationUf, destinationCity, km: km ?? null };
      routeKeys.add([originUf, normalizeText(originCity), destinationUf, normalizeText(destinationCity)].join("|"));
    } else if (group === null) {
      issues.push({
        row: rowNumber,
        column: "UF Origem",
        message: "Linha de continuação sem grupo de rota anterior (a primeira linha de dados deve ter origem preenchida).",
      });
      continue;
    }

    const vehicleType = cellText(tipo).toUpperCase();
    if (vehicleType === "") {
      issues.push({ row: rowNumber, column: "Tipo Veículo", message: "Tipo de veículo obrigatório." });
      continue;
    }

    const valorIdaCents = parsePriceCents(ida);
    if (valorIdaCents === undefined) {
      issues.push({ row: rowNumber, column: "Valor Ida", message: `Valor inválido: "${cellText(ida)}".` });
    }
    const valorReversaCents = parsePriceCents(reversa);
    if (valorReversaCents === undefined) {
      issues.push({ row: rowNumber, column: "Valor Reversa", message: `Valor inválido: "${cellText(reversa)}".` });
    }

    if (group) {
      const key = [group.originUf, normalizeText(group.originCity), group.destinationUf, normalizeText(group.destinationCity), vehicleType].join("|");
      const firstRow = seen.get(key);
      if (firstRow !== undefined) {
        issues.push({
          row: rowNumber,
          column: "Tipo Veículo",
          message: `Rota + tipo de veículo duplicados (mesma combinação da linha ${firstRow}). Corrija a planilha.`,
        });
      } else {
        seen.set(key, rowNumber);
      }
      rates.push({
        originUf: group.originUf,
        originCity: group.originCity,
        destinationUf: group.destinationUf,
        destinationCity: group.destinationCity,
        km: group.km,
        vehicleType,
        valorIdaCents: valorIdaCents === undefined ? null : valorIdaCents,
        valorReversaCents: valorReversaCents === undefined ? null : valorReversaCents,
        observacoes: cellText(obs) === "" ? null : cellText(obs),
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  if (rates.length === 0) {
    return { ok: false, issues: [{ row: 2, column: "-", message: "Nenhuma tarifa encontrada na planilha." }] };
  }
  return { ok: true, rates, routeCount: routeKeys.size };
}
