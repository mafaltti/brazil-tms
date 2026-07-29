import { test, expect, type Page } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";
import { auditLogs, customers, db, drivers, locations, trips } from "@brazil-tms/db";
import { dayRangeSaoPaulo } from "@brazil-tms/shared";
import { testAccounts, routes } from "./test-config";

/**
 * Feature 019 (issue #26) — fresh resource options: a driver registered AFTER a page is already
 * open appears in the assignment pickers with NO reload (polled + focus-refreshed option lists,
 * seeded by the server render). Self-seeds; FK-safe cleanup.
 */

function code(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function login(page: Page, account: { email: string; password: string }): Promise<void> {
  await page.goto(routes.login);
  await page.getByLabel(/e-?mail/i).fill(account.email);
  await page.getByLabel(/senha/i).fill(account.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith(routes.login), { timeout: 15_000 });
}

function farFutureDate(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 2);
  return d.toISOString().slice(0, 10);
}

let customerId = "";
let originId = "";
let destId = "";
let tripId = "";
let seededDriverName = "";
const driverIds: string[] = [];

test.beforeAll(async () => {
  const cust = await db
    .insert(customers)
    .values({ name: "Cliente Fresh 019", customerCode: code("CUST-FRESH") })
    .returning({ id: customers.id });
  customerId = cust[0]!.id;
  const origin = await db
    .insert(locations)
    .values({ customerId, code: code("ORIG"), name: "Origem Fresh" })
    .returning({ id: locations.id });
  originId = origin[0]!.id;
  const dest = await db
    .insert(locations)
    .values({ customerId, code: code("DEST"), name: "Destino Fresh" })
    .returning({ id: locations.id });
  destId = dest[0]!.id;

  const { from } = dayRangeSaoPaulo(new Date());
  const todayMidday = new Date(new Date(from).getTime() + 12 * 60 * 60 * 1000);
  const trip = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId: code("EXT-FRESH"),
      originLocationId: originId,
      destinationLocationId: destId,
      currentStatus: "received",
      originalPlan: { customerId, originLocationId: originId, destinationLocationId: destId },
      plannedVehicleType: "truck",
      plannedPickupWindowStart: todayMidday,
      plannedDeliveryWindowEnd: new Date(todayMidday.getTime() + 6 * 60 * 60 * 1000),
    })
    .returning({ id: trips.id });
  tripId = trip[0]!.id;

  // A driver that exists BEFORE the page loads — the first-paint (server-seed) regression check.
  seededDriverName = `Motorista Fresh Base ${code("B")}`;
  const seeded = await db
    .insert(drivers)
    .values({
      name: seededDriverName,
      ownershipType: "owned",
      status: "active",
      licenseExpiry: farFutureDate(),
    })
    .returning({ id: drivers.id });
  driverIds.push(seeded[0]!.id);
});

test.afterAll(async () => {
  if (tripId) {
    await db.delete(auditLogs).where(eq(auditLogs.entityId, tripId));
    await db.delete(trips).where(eq(trips.id, tripId));
  }
  if (driverIds.length) await db.delete(drivers).where(inArray(drivers.id, driverIds));
  for (const id of [originId, destId]) {
    if (id) await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
    if (id) await db.delete(locations).where(eq(locations.id, id));
  }
  if (customerId) {
    await db.delete(auditLogs).where(eq(auditLogs.entityId, customerId));
    await db.delete(customers).where(eq(customers.id, customerId));
  }
});

test("a driver registered while Trip Detail is open appears in the picker with NO reload (FR-001/FR-002); first paint keeps the server seed (FR-003)", async ({
  page,
}) => {
  // The FR-002 target is ≤60s (one poll interval); allow the full cycle + margin.
  test.setTimeout(120_000);
  await login(page, testAccounts.opsManager);
  await page.goto(`/trips/${tripId}`);

  // FR-003 — first paint: the server-seeded lists are available immediately.
  const driverPicker = page.getByLabel("Motorista", { exact: true });
  await driverPicker.click();
  await expect(page.getByRole("option", { name: seededDriverName })).toBeVisible();
  await page.keyboard.press("Escape");

  // Register a NEW driver while the tab stays open (the issue's emergency flow).
  const newDriverName = `Motorista Fresh Novo ${code("N")}`;
  const inserted = await db
    .insert(drivers)
    .values({
      name: newDriverName,
      ownershipType: "owned",
      status: "active",
      licenseExpiry: farFutureDate(),
    })
    .returning({ id: drivers.id });
  driverIds.push(inserted[0]!.id);

  // NO reload: within a refetch cycle the picker offers the new driver (FR-002 ≤60s + margin).
  // Each retry nudges the focus/visibility refetch (the tab-switch path); the 60s interval is the
  // guaranteed fallback either way.
  await expect(async () => {
    await page.evaluate(() => {
      window.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await page.keyboard.press("Escape");
    await driverPicker.click();
    await expect(page.getByRole("option", { name: newDriverName })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 90_000, intervals: [3_000] });
});
