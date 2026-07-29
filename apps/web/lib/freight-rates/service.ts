import "server-only";
import { and, asc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { db, freightRateImports, freightRates } from "@brazil-tms/db";
import type {
  FreightRateFilters,
  FreightRateImportSummary,
  FreightRateItem,
  FreightRateRow,
} from "@brazil-tms/shared";
import { writeAudit } from "@/lib/audit/write-audit";

/**
 * Feature 016 — freight rate service (contracts/freight-rates-api.md).
 * `replaceFreightRates` is the ONLY writer and runs delete-all + insert + import row + audit in
 * one transaction, so search always sees exactly one complete import (SC-004).
 */

export async function replaceFreightRates(
  rates: FreightRateRow[],
  routeCount: number,
  fileName: string,
  actorUserId: string,
): Promise<FreightRateImportSummary> {
  return db.transaction(async (tx) => {
    const [importRow] = await tx
      .insert(freightRateImports)
      .values({ fileName, uploadedBy: actorUserId, routeCount, rateCount: rates.length })
      .returning({ id: freightRateImports.id });
    if (!importRow) throw new Error("freight_rate_imports insert returned no row");

    await tx.delete(freightRates);
    await tx.insert(freightRates).values(
      rates.map((rate) => ({
        importId: importRow.id,
        originUf: rate.originUf,
        originCity: rate.originCity,
        destinationUf: rate.destinationUf,
        destinationCity: rate.destinationCity,
        km: rate.km,
        vehicleType: rate.vehicleType,
        valorIdaCents: rate.valorIdaCents,
        valorReversaCents: rate.valorReversaCents,
        observacoes: rate.observacoes,
      })),
    );

    await writeAudit(tx, {
      entityType: "freight_rate_import",
      entityId: importRow.id,
      action: "freight_rate.replace",
      previousValue: null,
      newValue: { fileName, routeCount, rateCount: rates.length },
      actorUserId,
    });

    return { id: importRow.id, fileName, routeCount, rateCount: rates.length };
  });
}

export async function queryFreightRates(filters: FreightRateFilters): Promise<FreightRateItem[]> {
  const conditions = [];
  if (filters.originUf) conditions.push(eq(freightRates.originUf, filters.originUf));
  if (filters.originCity) conditions.push(eq(freightRates.originCity, filters.originCity));
  if (filters.destinationUf) conditions.push(eq(freightRates.destinationUf, filters.destinationUf));
  if (filters.destinationCity) {
    conditions.push(eq(freightRates.destinationCity, filters.destinationCity));
  }
  const priceFiltered = filters.priceMinCents !== undefined || filters.priceMaxCents !== undefined;
  if (priceFiltered) {
    // Rows without Valor Ida are excluded only while a price bound is active (FR-003).
    conditions.push(isNotNull(freightRates.valorIdaCents));
    if (filters.priceMinCents !== undefined) {
      conditions.push(gte(freightRates.valorIdaCents, filters.priceMinCents));
    }
    if (filters.priceMaxCents !== undefined) {
      conditions.push(lte(freightRates.valorIdaCents, filters.priceMaxCents));
    }
  }

  const routeOrder = [
    asc(freightRates.originUf),
    asc(freightRates.originCity),
    asc(freightRates.destinationUf),
    asc(freightRates.destinationCity),
    asc(freightRates.createdAt),
    asc(freightRates.id),
  ];
  const orderBy =
    filters.sort === "valorIda"
      ? [sql`${freightRates.valorIdaCents} ASC NULLS LAST`, ...routeOrder]
      : filters.sort === "km"
        ? [sql`${freightRates.km} ASC NULLS LAST`, ...routeOrder]
        : routeOrder;

  const rows = await db
    .select({
      id: freightRates.id,
      originUf: freightRates.originUf,
      originCity: freightRates.originCity,
      destinationUf: freightRates.destinationUf,
      destinationCity: freightRates.destinationCity,
      km: freightRates.km,
      vehicleType: freightRates.vehicleType,
      valorIdaCents: freightRates.valorIdaCents,
      valorReversaCents: freightRates.valorReversaCents,
      observacoes: freightRates.observacoes,
    })
    .from(freightRates)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(...orderBy);

  return rows;
}
