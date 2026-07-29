import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, desc, eq } from "drizzle-orm";
import { auditLogs, db, freightRateImports, freightRates, users } from "@brazil-tms/db";
import type { FreightRateRow } from "@brazil-tms/shared";
import { queryFreightRates, replaceFreightRates } from "./service";

/**
 * 016 — service integration tests. Require a migrated + seeded dev DB (TESTING.md):
 * `uploaded_by` references a real seeded user. Synthetic rate data only (FR-009).
 */
const hasDb = !!process.env.DATABASE_URL;

function rate(overrides: Partial<FreightRateRow>): FreightRateRow {
  return {
    originUf: "AA",
    originCity: "CIDADE ALFA",
    destinationUf: "BB",
    destinationCity: "CIDADE BETA",
    km: 100,
    vehicleType: "CARRETA",
    valorIdaCents: 100000,
    valorReversaCents: null,
    observacoes: null,
    ...overrides,
  };
}

describe.skipIf(!hasDb)("freight-rates service (DB)", () => {
  let actorId: string;

  beforeAll(async () => {
    const [seeded] = await db.select({ id: users.id }).from(users).limit(1);
    if (!seeded) throw new Error("Seeded user required (run db:seed) for uploaded_by FK.");
    actorId = seeded.id;
  });

  beforeEach(async () => {
    await db.delete(freightRates);
    await db.delete(freightRateImports);
  });

  it("replaceFreightRates inserts rates, records the import and audits it", async () => {
    const summary = await replaceFreightRates(
      [rate({}), rate({ vehicleType: "TRUCK", valorIdaCents: null })],
      1,
      "sintetico.xlsx",
      actorId,
    );
    expect(summary.routeCount).toBe(1);
    expect(summary.rateCount).toBe(2);

    const stored = await queryFreightRates({});
    expect(stored).toHaveLength(2);

    const [importRow] = await db
      .select()
      .from(freightRateImports)
      .where(eq(freightRateImports.id, summary.id));
    expect(importRow?.fileName).toBe("sintetico.xlsx");

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityType, "freight_rate_import"))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(audit?.action).toBe("freight_rate.replace");
    expect(audit?.actorUserId).toBe(actorId);
    expect(audit?.newValue).toMatchObject({ fileName: "sintetico.xlsx", rateCount: 2 });
  });

  it("a second replace leaves only the new file's rates (replace-all)", async () => {
    await replaceFreightRates([rate({})], 1, "v1.xlsx", actorId);
    await replaceFreightRates(
      [rate({ originCity: "CIDADE GAMA", valorIdaCents: 50000 })],
      1,
      "v2.xlsx",
      actorId,
    );
    const stored = await queryFreightRates({});
    expect(stored).toHaveLength(1);
    expect(stored[0]?.originCity).toBe("CIDADE GAMA");
    // Import history keeps both rows.
    const imports = await db.select().from(freightRateImports).orderBy(asc(freightRateImports.createdAt));
    expect(imports).toHaveLength(2);
  });

  it("rolls back the whole replace when an insert fails (atomicity, SC-004)", async () => {
    await replaceFreightRates([rate({})], 1, "v1.xlsx", actorId);
    // Duplicate (route, vehicle) violates freight_rates_unique_idx mid-transaction.
    await expect(
      replaceFreightRates([rate({ valorIdaCents: 1 }), rate({ valorIdaCents: 2 })], 1, "quebrado.xlsx", actorId),
    ).rejects.toThrow();
    const stored = await queryFreightRates({});
    expect(stored).toHaveLength(1);
    expect(stored[0]?.valorIdaCents).toBe(100000);
  });

  it("filters by UF and price range excluding null Valor Ida only under a price bound", async () => {
    await replaceFreightRates(
      [
        rate({}),
        rate({ vehicleType: "TRUCK", valorIdaCents: null }),
        rate({ originUf: "CC", originCity: "CIDADE GAMA", valorIdaCents: 300000 }),
      ],
      2,
      "filtros.xlsx",
      actorId,
    );

    expect(await queryFreightRates({ originUf: "AA" })).toHaveLength(2);
    // No price bound: the null-Ida row appears.
    expect(await queryFreightRates({})).toHaveLength(3);
    // Price bound: null-Ida row excluded, range applied.
    const priced = await queryFreightRates({ priceMinCents: 50000, priceMaxCents: 200000 });
    expect(priced).toHaveLength(1);
    expect(priced[0]?.valorIdaCents).toBe(100000);
  });

  it("sorts by valorIda with nulls last", async () => {
    await replaceFreightRates(
      [
        rate({ valorIdaCents: 200000 }),
        rate({ vehicleType: "TRUCK", valorIdaCents: null }),
        rate({ vehicleType: "TOCO", valorIdaCents: 100000 }),
      ],
      1,
      "ordenacao.xlsx",
      actorId,
    );
    const sorted = await queryFreightRates({ sort: "valorIda" });
    expect(sorted.map((r) => r.valorIdaCents)).toEqual([100000, 200000, null]);
  });
});
