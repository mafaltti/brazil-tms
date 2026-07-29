import { test, expect, type APIRequestContext } from "@playwright/test";
import ExcelJS from "exceljs";
import { db, freightRateImports, freightRates } from "@brazil-tms/db";
import { FREIGHT_SHEET_HEADER, FREIGHT_SHEET_NAME } from "@brazil-tms/shared";
import { testAccounts } from "./test-config";

/**
 * Feature 016 — freight rate lookup e2e (HTTP-level). Admin/Finance replace the table by upload
 * (US2); every internal role searches (US1); dispatcher upload is denied (403); a broken file is
 * rejected with row/column findings and changes nothing. SYNTHETIC data only — the real sheet
 * never enters the repo (FR-009).
 */

async function apiLogin(
  request: APIRequestContext,
  account: { email: string; password: string },
): Promise<void> {
  const res = await request.post("/api/auth/sign-in", {
    data: { email: account.email, password: account.password },
  });
  expect(res.ok()).toBeTruthy();
}

async function buildSheet(rows: unknown[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(FREIGHT_SHEET_NAME);
  sheet.addRow([...FREIGHT_SHEET_HEADER]);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function uploadPayload(buffer: Buffer, name = "fretes-sinteticos.xlsx") {
  return {
    multipart: {
      file: { name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer },
    },
  };
}

test.beforeEach(async () => {
  await db.delete(freightRates);
  await db.delete(freightRateImports);
});

test("admin replaces the table and every filter path answers (US1+US2)", async ({ request }) => {
  await apiLogin(request, testAccounts.admin);

  const buffer = await buildSheet([
    ["AA", "CIDADE ALFA", "BB", "CIDADE BETA", 100, "CARRETA", "R$ 1.000,00", "-", "nota"],
    ["", "", "", "", "", "TRUCK", 800, "-", ""],
    ["", "", "", "", "", "TOCO", "-", "-", ""],
    ["CC", "CIDADE GAMA", "AA", "CIDADE ALFA", 50, "CARRETA", 3000, "R$ 500,00", ""],
  ]);
  const upload = await request.post("/api/freight-rates/import", uploadPayload(buffer));
  expect(upload.status()).toBe(201);
  const { item } = (await upload.json()) as { item: { routeCount: number; rateCount: number } };
  expect(item.routeCount).toBe(2);
  expect(item.rateCount).toBe(4);

  const all = await request.get("/api/freight-rates");
  expect(all.ok()).toBeTruthy();
  const { items } = (await all.json()) as { items: { valorIdaCents: number | null }[] };
  expect(items).toHaveLength(4);

  const filtered = await request.get("/api/freight-rates?originUf=AA&priceMinCents=50000&priceMaxCents=150000");
  const filteredBody = (await filtered.json()) as {
    items: { vehicleType: string; valorIdaCents: number | null }[];
  };
  // TOCO (no Valor Ida) excluded under the price bound; CARRETA 100000 and TRUCK 80000 remain.
  expect(filteredBody.items.map((r) => r.vehicleType).sort()).toEqual(["CARRETA", "TRUCK"]);

  const sorted = await request.get("/api/freight-rates?sort=valorIda");
  const sortedBody = (await sorted.json()) as { items: { valorIdaCents: number | null }[] };
  expect(sortedBody.items.at(-1)?.valorIdaCents).toBeNull();
});

test("a broken sheet is rejected with findings and changes nothing (US2)", async ({ request }) => {
  await apiLogin(request, testAccounts.admin);

  const good = await buildSheet([
    ["AA", "CIDADE ALFA", "BB", "CIDADE BETA", 10, "CARRETA", 100, "-", ""],
  ]);
  expect((await request.post("/api/freight-rates/import", uploadPayload(good))).status()).toBe(201);

  const broken = await buildSheet([
    ["XYZ", "CIDADE ALFA", "BB", "CIDADE BETA", "abc", "CARRETA", "talvez", "-", ""],
  ]);
  const rejected = await request.post("/api/freight-rates/import", uploadPayload(broken, "quebrado.xlsx"));
  expect(rejected.status()).toBe(409);
  const body = (await rejected.json()) as {
    error: { code: string };
    findings?: { row: number; column: string }[];
  };
  expect(body.error.code).toBe("INVALID_FILE");
  expect(body.findings?.length).toBeGreaterThan(0);

  // Previous data intact.
  const after = await request.get("/api/freight-rates");
  const { items } = (await after.json()) as { items: unknown[] };
  expect(items).toHaveLength(1);
});

test("dispatcher searches but cannot upload (FR-001/FR-005)", async ({ request }) => {
  await apiLogin(request, testAccounts.dispatcher);
  const read = await request.get("/api/freight-rates");
  expect(read.ok()).toBeTruthy();
  const buffer = await buildSheet([
    ["AA", "CIDADE ALFA", "BB", "CIDADE BETA", 10, "CARRETA", 100, "-", ""],
  ]);
  const denied = await request.post("/api/freight-rates/import", uploadPayload(buffer));
  expect(denied.status()).toBe(403);
});

test("unauthenticated requests get no rate data (SC-005)", async ({ request }) => {
  const res = await request.get("/api/freight-rates");
  expect(res.status()).toBe(401);
});
