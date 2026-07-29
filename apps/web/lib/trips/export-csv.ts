import "server-only";
import type { TripBoardRow } from "@brazil-tms/db";

const BOM = "﻿";
const DELIMITER = ";";
const EOL = "\r\n";

/** pt-BR header, in the board column order (R7 export = board projection). */
const HEADER = [
  "ID externo",
  "Cliente",
  "Origem (código)",
  "Origem",
  "Destino (código)",
  "Destino",
  "Rota",
  "Status",
  "Faturamento",
  "Coleta (início)",
  "Coleta (fim)",
  "Entrega (início)",
  "Entrega (fim)",
  "Veículo",
  "Atualizada",
] as const;

/** Escape one CSV field for the `;`-delimited pt-BR dialect (Excel default). */
function escapeField(value: string | null | undefined): string {
  if (value == null) return "";
  if (/[;"\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function rowToFields(row: TripBoardRow): readonly (string | null)[] {
  return [
    row.externalTripId,
    row.customerName,
    row.originCode,
    row.originName,
    row.destinationCode,
    row.destinationName,
    row.laneLabel,
    row.currentStatus,
    row.billingStatus,
    row.plannedPickupWindowStart,
    row.plannedPickupWindowEnd,
    row.plannedDeliveryWindowStart,
    row.plannedDeliveryWindowEnd,
    row.plannedVehicleType,
    row.updatedAt,
  ];
}

/**
 * Render board rows as a UTF-8 (BOM-prefixed) CSV string using `;` + CRLF — the pt-BR Excel dialect.
 * Enum values (`currentStatus`, `billingStatus`) and timestamps are emitted raw; `null` → empty cell.
 */
export function tripRowsToCsv(rows: TripBoardRow[]): string {
  const lines: string[] = [];
  lines.push(HEADER.map((h) => escapeField(h)).join(DELIMITER));
  for (const row of rows) {
    lines.push(rowToFields(row).map((f) => escapeField(f)).join(DELIMITER));
  }
  return BOM + lines.join(EOL) + EOL;
}
