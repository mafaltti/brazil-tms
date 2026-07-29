import { test, expect, type Page } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  customers,
  db,
  drivers,
  locations,
  tripAssignments,
  tripEvents,
  trips,
  vehicles,
} from "@brazil-tms/db";
import { dayRangeSaoPaulo } from "@brazil-tms/shared";
import { testAccounts, routes } from "./test-config";

/**
 * Feature 018 (issue #25) — searchable resource pickers: type/paste-to-select on the assignment
 * form's comboboxes and the Control Tower's resource filters. Self-seeds two SIMILAR drivers
 * (accent-bearing names) and two plates one character apart — the issue's exact pain — plus one
 * `received` trip pinned to today's São Paulo window. FK-safe cleanup; unique ids.
 *
 * SERIAL: the US3 board-filter test relies on the assignment performed by the US1/US2 flow test
 * (the trip must carry driverSouza), and all tests share the one seeded trip.
 */
test.describe.configure({ mode: "serial" });

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

let customerId = "";
let originId = "";
let destId = "";
let tripId = "";
let tripExternalId = "";
// Two similar accent-bearing names (suffix disambiguates runs; the shared surname is the collision).
let driverSantos = "";
let driverSouza = "";
// Two plates one character apart.
let plateA = "";
let plateB = "";
const driverIds: string[] = [];
const vehicleIds: string[] = [];

test.beforeAll(async () => {
  const cust = await db
    .insert(customers)
    .values({ name: "Cliente Pickers 018", customerCode: code("CUST-PICK") })
    .returning({ id: customers.id });
  customerId = cust[0]!.id;
  const origin = await db
    .insert(locations)
    .values({ customerId, code: code("ORIG"), name: "Origem Pickers" })
    .returning({ id: locations.id });
  originId = origin[0]!.id;
  const dest = await db
    .insert(locations)
    .values({ customerId, code: code("DEST"), name: "Destino Pickers" })
    .returning({ id: locations.id });
  destId = dest[0]!.id;

  const { from } = dayRangeSaoPaulo(new Date());
  const todayMidday = new Date(new Date(from).getTime() + 12 * 60 * 60 * 1000);
  tripExternalId = code("EXT-PICK");
  const trip = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId: tripExternalId,
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

  function farFutureDate(): string {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 2);
    return d.toISOString().slice(0, 10);
  }

  const suffix = code("S");
  driverSantos = `João da Silva Santos ${suffix}`;
  driverSouza = `João da Silva Souza ${suffix}`;
  for (const name of [driverSantos, driverSouza]) {
    const d = await db
      .insert(drivers)
      .values({ name, ownershipType: "owned", status: "active", licenseExpiry: farFutureDate() })
      .returning({ id: drivers.id });
    driverIds.push(d[0]!.id);
  }

  // Plates one character apart (letters only, then a digit differing at the tail).
  const letter = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
  const stem = `${letter()}${letter()}${letter()}${Math.floor(100 + Math.random() * 900)}`;
  plateA = `${stem}3`;
  plateB = `${stem}4`;
  for (const plate of [plateA, plateB]) {
    const v = await db
      .insert(vehicles)
      .values({
        plate,
        vehicleType: "truck",
        ownershipType: "owned",
        status: "active",
        documentExpiry: farFutureDate(),
      })
      .returning({ id: vehicles.id });
    vehicleIds.push(v[0]!.id);
  }
});

test.afterAll(async () => {
  if (tripId) {
    await db.delete(tripAssignments).where(eq(tripAssignments.tripId, tripId));
    await db.delete(tripEvents).where(eq(tripEvents.tripId, tripId));
    await db.delete(auditLogs).where(eq(auditLogs.entityId, tripId));
    await db.delete(trips).where(eq(trips.id, tripId));
  }
  if (driverIds.length) await db.delete(drivers).where(inArray(drivers.id, driverIds));
  if (vehicleIds.length) await db.delete(vehicles).where(inArray(vehicles.id, vehicleIds));
  for (const id of [originId, destId]) {
    if (id) await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
    if (id) await db.delete(locations).where(eq(locations.id, id));
  }
  if (customerId) {
    await db.delete(auditLogs).where(eq(auditLogs.entityId, customerId));
    await db.delete(customers).where(eq(customers.id, customerId));
  }
});

test.describe("US1/US2 — assignment form comboboxes", () => {
  test("typing filters accent/case-insensitively; similar names are disambiguated (FR-001/FR-002)", async ({
    page,
  }) => {
    await login(page, testAccounts.opsManager);
    await page.goto(`/trips/${tripId}`);

    const driverInput = page.getByLabel("Motorista", { exact: true });
    await driverInput.click();
    // Unaccented lowercase fragment matches both accent-bearing names.
    await driverInput.fill("joao da silva");
    await expect(page.getByRole("option", { name: driverSantos })).toBeVisible();
    await expect(page.getByRole("option", { name: driverSouza })).toBeVisible();
    // One more word narrows to one — Enter picks the single remaining option (keyboard-only, SC-004).
    await driverInput.press("End");
    await driverInput.pressSequentially(" santos");
    await expect(page.getByRole("option", { name: driverSouza })).toBeHidden();
    await driverInput.press("Enter");
    await expect(driverInput).toHaveValue(driverSantos);
  });

  test("pasting the full name auto-selects; the assignment completes end-to-end (FR-003/FR-007)", async ({
    page,
  }) => {
    await login(page, testAccounts.opsManager);
    await page.goto(`/trips/${tripId}`);

    // Paste (fill = programmatic insertion, the paste-equivalent) the full name, lowercased and
    // unaccented — auto-selects the unique match.
    const driverInput = page.getByLabel("Motorista", { exact: true });
    await driverInput.click();
    await driverInput.fill(driverSouza.toLowerCase().replace("ã", "a"));
    await expect(driverInput).toHaveValue(driverSouza);

    // Plate paste with hyphen + lowercase still finds the exact plate (FR-002 plate mode).
    const vehicleInput = page.getByLabel("Veículo", { exact: true });
    await vehicleInput.click();
    const decorated = `${plateB.slice(0, 3)}-${plateB.slice(3)}`.toLowerCase();
    await vehicleInput.fill(decorated);
    await expect(vehicleInput).toHaveValue(plateB);

    // The write path is untouched: the same Atribuir flow completes (received → assigned) — the
    // refetched form flips to reassign mode ("Substituir atribuição").
    await page.getByRole("button", { name: "Atribuir", exact: true }).click();
    await expect(page.getByRole("button", { name: "Substituir atribuição" })).toBeVisible({
      timeout: 15_000,
    });
    const row = (
      await db.select({ s: trips.currentStatus }).from(trips).where(eq(trips.id, tripId)).limit(1)
    )[0]!;
    expect(row.s).toBe("assigned");
  });

  test("near-identical plates: the shared stem shows both, the full plate narrows to one (SC-002)", async ({
    page,
  }) => {
    await login(page, testAccounts.opsManager);
    await page.goto(`/trips/${tripId}`);

    const vehicleInput = page.getByLabel("Veículo", { exact: true });
    await vehicleInput.click();
    await vehicleInput.fill(plateA.slice(0, plateA.length - 1)); // the stem both plates share
    await expect(page.getByRole("option", { name: plateA })).toBeVisible();
    await expect(page.getByRole("option", { name: plateB })).toBeVisible();
    await vehicleInput.fill(plateA);
    await expect(vehicleInput).toHaveValue(plateA);
  });

  test("no match shows the empty state; clearing restores the list (FR-004); clear item reachable while searching (FR-006)", async ({
    page,
  }) => {
    await login(page, testAccounts.opsManager);
    await page.goto(`/trips/${tripId}`);

    const driverInput = page.getByLabel("Motorista", { exact: true });
    await driverInput.click();
    await driverInput.fill("zzz-ninguem-tem-esse-nome");
    await expect(page.getByText("Nenhum resultado")).toBeVisible();
    await driverInput.fill("");
    await expect(page.getByRole("option", { name: driverSantos })).toBeVisible();
    await driverInput.press("Escape");

    // The pinned clear item stays reachable regardless of the trailer search text.
    const trailerInput = page.getByLabel("Reboque", { exact: true });
    await trailerInput.click();
    await trailerInput.fill("xxxxxx");
    await expect(page.getByRole("option", { name: "Sem reboque" })).toBeVisible();
  });
});

test.describe("US3 — Control Tower resource filters", () => {
  test("pasting a full driver name into the board filter selects it and narrows the board (FR-009)", async ({
    page,
  }) => {
    await login(page, testAccounts.opsManager);
    await page.goto("/trips");

    const filter = page.getByLabel("Motorista", { exact: true });
    await filter.click();
    await filter.fill(driverSouza.toLowerCase());
    await expect(filter).toHaveValue(driverSouza);

    // The previous test assigned driverSouza to the seeded trip — the filtered board shows it.
    await expect(page.getByRole("row", { name: new RegExp(tripExternalId) })).toBeVisible({
      timeout: 15_000,
    });

    // "Todos" (the pinned clear item) resets the filter.
    await filter.click();
    await expect(page.getByRole("option", { name: "Todos" }).first()).toBeVisible();
  });
});
