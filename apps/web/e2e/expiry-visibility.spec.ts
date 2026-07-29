import { test, expect, type Page } from "@playwright/test";
import { inArray } from "drizzle-orm";
import { db, drivers, vehicles } from "@brazil-tms/db";
import { testAccounts, routes } from "./test-config";

/**
 * Feature 020 (issue #27) — license/document expiry visibility: the resource lists show the DATE
 * plus the derived warning/expired states; a missing date reads "Não informada" (never conflated
 * with healthy). Seeds four driver states + one expired vehicle; searches by unique name/plate to
 * isolate rows. FK-safe cleanup.
 */

function code(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function isoOffsetDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** dd/MM/yyyy as `formatDate` renders (São Paulo calendar dates round-trip as stored). */
function brDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

async function login(page: Page, account: { email: string; password: string }): Promise<void> {
  await page.goto(routes.login);
  await page.getByLabel(/e-?mail/i).fill(account.email);
  await page.getByLabel(/senha/i).fill(account.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith(routes.login), { timeout: 15_000 });
}

const driverIds: string[] = [];
const vehicleIds: string[] = [];

const okDate = isoOffsetDays(365);
const expiringDate = isoOffsetDays(10);
const expiredDate = isoOffsetDays(-5);

let nameNone = "";
let nameOk = "";
let nameExpiring = "";
let nameExpired = "";
let plateExpired = "";

test.beforeAll(async () => {
  // Neutral names — they must NOT contain the badge texts ("A vencer"/"Vencido"/"Não informada"),
  // or row-scoped getByText matches the name too (strict-mode violation).
  nameNone = `Exp SemData ${code("D")}`;
  nameOk = `Exp Futuro ${code("D")}`;
  nameExpiring = `Exp Janela ${code("D")}`;
  nameExpired = `Exp Passada ${code("D")}`;
  const rows = await db
    .insert(drivers)
    .values([
      { name: nameNone, ownershipType: "owned", status: "active", licenseExpiry: null },
      { name: nameOk, ownershipType: "owned", status: "active", licenseExpiry: okDate },
      { name: nameExpiring, ownershipType: "owned", status: "active", licenseExpiry: expiringDate },
      { name: nameExpired, ownershipType: "owned", status: "active", licenseExpiry: expiredDate },
    ])
    .returning({ id: drivers.id });
  driverIds.push(...rows.map((r) => r.id));

  const letter = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
  plateExpired = `${letter()}${letter()}${letter()}${Math.floor(1000 + Math.random() * 9000)}`;
  const veh = await db
    .insert(vehicles)
    .values({
      plate: plateExpired,
      vehicleType: "truck",
      ownershipType: "owned",
      status: "active",
      documentExpiry: expiredDate,
    })
    .returning({ id: vehicles.id });
  vehicleIds.push(veh[0]!.id);
});

test.afterAll(async () => {
  if (driverIds.length) await db.delete(drivers).where(inArray(drivers.id, driverIds));
  if (vehicleIds.length) await db.delete(vehicles).where(inArray(vehicles.id, vehicleIds));
});

/** Search the list by the unique name/plate and return the isolated row. */
async function isolatedRow(page: Page, term: string) {
  const search = page.getByPlaceholder(/buscar/i);
  await search.fill(term);
  const row = page.getByRole("row", { name: new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
  await expect(row).toBeVisible({ timeout: 15_000 });
  return row;
}

test("drivers list shows the CNH date with the four states (FR-001..FR-003)", async ({ page }) => {
  await login(page, testAccounts.fleetCoord);
  await page.goto("/resources/drivers");

  // No date → "Não informada", never a healthy dash.
  let row = await isolatedRow(page, nameNone);
  await expect(row.getByText("Não informada")).toBeVisible();

  // Healthy → the plain date, no badge.
  row = await isolatedRow(page, nameOk);
  await expect(row.getByText(brDate(okDate))).toBeVisible();
  await expect(row.getByText("A vencer")).toHaveCount(0);
  await expect(row.getByText("Vencido")).toHaveCount(0);

  // Inside the 30-day window → date + "A vencer".
  row = await isolatedRow(page, nameExpiring);
  await expect(row.getByText(brDate(expiringDate))).toBeVisible();
  await expect(row.getByText("A vencer")).toBeVisible();

  // Expired → date + red "Vencido".
  row = await isolatedRow(page, nameExpired);
  await expect(row.getByText(brDate(expiredDate))).toBeVisible();
  await expect(row.getByText("Vencido")).toBeVisible();
});

test("vehicles list gets the same treatment (FR-004)", async ({ page }) => {
  await login(page, testAccounts.fleetCoord);
  await page.goto("/resources/vehicles");

  const row = await isolatedRow(page, plateExpired);
  await expect(row.getByText(brDate(expiredDate))).toBeVisible();
  await expect(row.getByText("Vencido")).toBeVisible();
});
