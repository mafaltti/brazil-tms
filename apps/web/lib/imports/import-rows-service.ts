import "server-only";
import { and, asc, count, eq, type SQL } from "drizzle-orm";
import { db, importRows } from "@brazil-tms/db";

/** API response shape for one import row (contract: bff-endpoints.md §`GET /api/imports/{id}/rows`). */
export interface ImportRowDto {
  rowNumber: number;
  outcome: "valid" | "warning" | "error" | null;
  matchDecision: "new" | "update" | "no_op" | "potential_duplicate" | "unresolved" | null;
  reasons: { code: string; field?: string; message: string }[];
  mapped: Record<string, unknown> | null;
  targetTripId: string | null;
}

interface ImportRowRow {
  rowNumber: number;
  outcome: "valid" | "warning" | "error" | null;
  matchDecision:
    | "new"
    | "update"
    | "no_op"
    | "potential_duplicate"
    | "unresolved"
    | null;
  reasons: unknown;
  mapped: unknown;
  targetTripId: string | null;
}

function toDto(row: ImportRowRow): ImportRowDto {
  return {
    rowNumber: row.rowNumber,
    outcome: row.outcome,
    matchDecision: row.matchDecision,
    reasons: (row.reasons as ImportRowDto["reasons"] | null) ?? [],
    mapped: (row.mapped as Record<string, unknown> | null) ?? null,
    targetTripId: row.targetTripId,
  };
}

const DEFAULT_LIMIT = 100;
const DEFAULT_OFFSET = 0;

export interface ListRowsOptions {
  outcome?: string;
  match?: string;
  limit?: number;
  offset?: number;
}

export async function listRows(
  batchId: string,
  opts: ListRowsOptions = {},
): Promise<{ items: ImportRowDto[]; total: number }> {
  const filters: SQL[] = [eq(importRows.importBatchId, batchId)];
  if (opts.outcome) {
    filters.push(
      eq(importRows.outcome, opts.outcome as "valid" | "warning" | "error"),
    );
  }
  if (opts.match) {
    filters.push(
      eq(
        importRows.matchDecision,
        opts.match as "new" | "update" | "no_op" | "potential_duplicate" | "unresolved",
      ),
    );
  }
  const where = and(...filters);

  const limit = opts.limit ?? DEFAULT_LIMIT;
  const offset = opts.offset ?? DEFAULT_OFFSET;

  const rows = await db
    .select({
      rowNumber: importRows.rowNumber,
      outcome: importRows.outcome,
      matchDecision: importRows.matchDecision,
      reasons: importRows.reasons,
      mapped: importRows.mapped,
      targetTripId: importRows.targetTripId,
    })
    .from(importRows)
    .where(where)
    .orderBy(asc(importRows.rowNumber))
    .limit(limit)
    .offset(offset);

  const totalRows = await db
    .select({ value: count() })
    .from(importRows)
    .where(where);
  const total = totalRows[0]?.value ?? 0;

  return { items: rows.map(toDto), total };
}
