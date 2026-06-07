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
  users,
  vehicles,
} from "@brazil-tms/db";
import { dayRangeSaoPaulo } from "@brazil-tms/shared";
import { testAccounts, routes } from "./test-config";

/**
 * US5 (Dispatch Board + operating-board integration) — feature 006 UI, driven against the running app
 * (T069). Authored against the e2e-seeded Operations Manager (holds `assign_resources`, so the
 * `/dispatch` server guard admits it and the quick-assign action renders). Selectors lean on pt-BR UI
 * strings (`Dispatch.*`, `Trips.board.*`).
 *
 * Covers: `/dispatch` lists the unassigned-by-pickup queue and exposes an assign action per trip;
 * `/trips` surfaces the assignment filters + the "Não atribuídas" (Unassigned) quick-view + the
 * assignment row indicator + the per-row quick-assign action; `/` (Home) renders the "Viagens sem
 * atribuição" widget with a deep-link into the Unassigned view.
 *
 * Self-seeds via `@brazil-tms/db`: one customer + locations + an UNASSIGNED `received` trip pinned to
 * today's São Paulo pickup window (so it shows on the board and counts on the dashboard) + clean
 * resources for the assign form. FK-safe cleanup; unique ids.
 *
 * Slice 015 INVERTED slice 014's queue: the dispatch queue now filters `status=received` (was
 * `status=validated`), so a `received` trip is INCLUDED (it is the first dispatchable status) and the
 * assign hop is `received → assigned`.
 */

const ADMIN_EMAIL = "admin@braziltransports.com.br";

function code(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}
function uniquePlate(): string {
  const letter = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `${letter()}${letter()}${letter()}${Math.floor(1000 + Math.random() * 9000)}`;
}
function farFutureDate(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 2);
  return d.toISOString().slice(0, 10);
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
let driverId = "";
let vehicleId = "";
let driverName = "";
let vehiclePlate = "";
let unassignedExternalId = "";
let unassignedTripId = "";
// Slice 015 (INVERTED): a second `received` trip the queue must now INCLUDE (was the excluded trip
// under slice 014's validated-only queue), and a dedicated `received` trip used to drive a COMPLETE
// assignment through the form (kept separate from `unassignedTripId`, which later Control-Tower tests
// rely on staying unassigned).
let receivedExternalId = "";
let receivedTripId = "";
let assignableExternalId = "";
let assignableTripId = "";
const tripIds: string[] = [];

test.beforeAll(async () => {
  const admin = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, ADMIN_EMAIL))
    .limit(1);
  expect(admin[0]?.id, "seeded admin must exist (run db:seed:e2e)").toBeTruthy();

  const cust = await db
    .insert(customers)
    .values({ name: "Cliente Board US5", customerCode: code("CUST") })
    .returning({ id: customers.id });
  customerId = cust[0]!.id;
  const origin = await db
    .insert(locations)
    .values({ customerId, code: code("ORIG"), name: "Origem Board" })
    .returning({ id: locations.id });
  originId = origin[0]!.id;
  const dest = await db
    .insert(locations)
    .values({ customerId, code: code("DEST"), name: "Destino Board" })
    .returning({ id: locations.id });
  destId = dest[0]!.id;

  // Pin the pickup to the middle of the current São Paulo day so the trip lands in "today" regardless
  // of the host timezone and counts toward the active unassigned set.
  const { from } = dayRangeSaoPaulo(new Date());
  const todayMidday = new Date(new Date(from).getTime() + 12 * 60 * 60 * 1000);

  unassignedExternalId = code("EXT-BOARD");
  const trip = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId: unassignedExternalId,
      originLocationId: originId,
      destinationLocationId: destId,
      currentStatus: "received",
      originalPlan: { customerId, originLocationId: originId, destinationLocationId: destId },
      plannedVehicleType: "truck",
      plannedPickupWindowStart: todayMidday,
      plannedDeliveryWindowEnd: new Date(todayMidday.getTime() + 6 * 60 * 60 * 1000),
    })
    .returning({ id: trips.id });
  unassignedTripId = trip[0]!.id;
  tripIds.push(unassignedTripId);

  // A second `received` trip, also unassigned + today: slice 015 INVERTED the slice-014 exclusion — the
  // `status=received` queue now INCLUDES it (it is the first dispatchable status; FR-006).
  receivedExternalId = code("EXT-RECEBIDA");
  const receivedTrip = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId: receivedExternalId,
      originLocationId: originId,
      destinationLocationId: destId,
      currentStatus: "received",
      originalPlan: { customerId, originLocationId: originId, destinationLocationId: destId },
      plannedVehicleType: "truck",
      plannedPickupWindowStart: todayMidday,
      plannedDeliveryWindowEnd: new Date(todayMidday.getTime() + 6 * 60 * 60 * 1000),
    })
    .returning({ id: trips.id });
  receivedTripId = receivedTrip[0]!.id;
  tripIds.push(receivedTripId);

  // A second `received`, unassigned trip used solely to complete an assignment via the form.
  assignableExternalId = code("EXT-ATRIBUIR");
  const assignableTrip = await db
    .insert(trips)
    .values({
      customerId,
      externalTripId: assignableExternalId,
      originLocationId: originId,
      destinationLocationId: destId,
      currentStatus: "received",
      originalPlan: { customerId, originLocationId: originId, destinationLocationId: destId },
      plannedVehicleType: "truck",
      plannedPickupWindowStart: todayMidday,
      plannedDeliveryWindowEnd: new Date(todayMidday.getTime() + 6 * 60 * 60 * 1000),
    })
    .returning({ id: trips.id });
  assignableTripId = assignableTrip[0]!.id;
  tripIds.push(assignableTripId);

  driverName = `Motorista Board ${code("D")}`;
  const drv = await db
    .insert(drivers)
    .values({
      name: driverName,
      ownershipType: "owned",
      status: "active",
      licenseExpiry: farFutureDate(),
    })
    .returning({ id: drivers.id });
  driverId = drv[0]!.id;
  vehiclePlate = uniquePlate();
  const veh = await db
    .insert(vehicles)
    .values({
      plate: vehiclePlate,
      vehicleType: "truck",
      ownershipType: "owned",
      status: "active",
      documentExpiry: farFutureDate(),
    })
    .returning({ id: vehicles.id });
  vehicleId = veh[0]!.id;
});

test.afterAll(async () => {
  if (tripIds.length) {
    await db.delete(tripAssignments).where(inArray(tripAssignments.tripId, tripIds));
    await db.delete(tripEvents).where(inArray(tripEvents.tripId, tripIds));
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, tripIds));
    await db.delete(trips).where(inArray(trips.id, tripIds));
  }
  if (driverId) await db.delete(drivers).where(eq(drivers.id, driverId));
  if (vehicleId) await db.delete(vehicles).where(eq(vehicles.id, vehicleId));
  for (const id of [originId, destId]) {
    if (id) await db.delete(locations).where(eq(locations.id, id));
  }
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

test.describe("US5 — Dispatch Board", () => {
  test("/dispatch lists the unassigned-by-pickup queue with an assign action", async ({ page }) => {
    await login(page, testAccounts.opsManager);
    await page.goto("/dispatch");

    // The page heading + queue card (the CardTitle renders as text, not a heading role).
    await expect(page.getByRole("heading", { name: "Expedição", level: 1 })).toBeVisible();
    await expect(page.getByText("Fila de atribuição")).toBeVisible({ timeout: 15_000 });

    // The seeded unassigned trip's external id links into Trip Detail.
    const tripLink = page.getByRole("link", { name: unassignedExternalId });
    await expect(tripLink).toBeVisible({ timeout: 15_000 });
    await expect(tripLink).toHaveAttribute("href", `/trips/${unassignedTripId}`);

    // Slice 015 (INVERTED, FR-006): the `status=received` queue INCLUDES a `received` trip — it is the
    // first dispatchable status, so its "Atribuir" succeeds (`received → assigned`). (Under slice 014's
    // validated-only queue this trip was EXCLUDED; the collapse flips that.)
    await expect(page.getByRole("link", { name: receivedExternalId })).toBeVisible({ timeout: 15_000 });

    // The per-row assign action ("Atribuir") opens the shared assignment form dialog.
    const row = page.getByRole("listitem").filter({ hasText: unassignedExternalId });
    await row.getByRole("button", { name: "Atribuir" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // The shared AssignmentForm exposes the driver picker (label "Motorista").
    await expect(dialog.getByText("Motorista", { exact: true })).toBeVisible();
  });

  test("a complete assignment from the received queue succeeds (received → assigned) (slice 015)", async ({
    page,
  }) => {
    await login(page, testAccounts.opsManager);
    await page.goto("/dispatch");
    await expect(page.getByText("Fila de atribuição")).toBeVisible({ timeout: 15_000 });

    // Open the assign dialog for the dedicated received trip.
    const row = page.getByRole("listitem").filter({ hasText: assignableExternalId });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole("button", { name: "Atribuir" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Pick the seeded driver + vehicle. Radix Select renders its options in a portal, so the option
    // role is queried at the page level (driver label = name, vehicle label = plate).
    await dialog.getByLabel("Motorista", { exact: true }).click();
    await page.getByRole("option", { name: driverName }).click();
    await dialog.getByLabel("Veículo", { exact: true }).click();
    await page.getByRole("option", { name: vehiclePlate }).click();

    // Clean (owned, matching, active, non-expired) resources ⇒ no block/warn findings ⇒ the assign
    // action enables; submit it. onDone closes the dialog ONLY on a successful assign (a failure keeps
    // it open with an error), so a hidden dialog is the success signal (received → assigned).
    await dialog.getByRole("button", { name: "Atribuir" }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
  });
});

test.describe("US5 — Control Tower assignment integration", () => {
  test("the 'Não atribuídas' view + assignment filters narrow the list; the row indicator shows state", async ({
    page,
  }) => {
    await login(page, testAccounts.opsManager);
    await page.goto("/trips");

    // The assignment row-indicator column header is present (fills 005 FR-007).
    await expect(
      page.getByRole("columnheader", { name: "Atribuição" }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Apply the "Não atribuídas" (Unassigned) quick-view — sets ?assigned=false&scope=active. The same
    // label is used by the assigned tri-state filter AND the quick-view, so scope to the "Visões"
    // (quick-views) group.
    const viewsGroup = page
      .locator("div.space-y-1\\.5")
      .filter({ has: page.getByText("Visões", { exact: true }) });
    await viewsGroup.getByRole("button", { name: "Não atribuídas", exact: true }).click();
    await page.waitForFunction(() => new URLSearchParams(location.search).get("assigned") === "false");

    // The seeded unassigned trip shows in the narrowed list with the "Não atribuídas" row indicator
    // (the `assignedNo` label rendered by the assignment column for an unassigned row).
    const row = page.getByRole("row", { name: new RegExp(unassignedExternalId) });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText("Não atribuídas")).toBeVisible();
  });

  test("a per-row quick-assign action opens the assignment form (third entry point)", async ({
    page,
  }) => {
    await login(page, testAccounts.opsManager);
    // Search straight for the seeded trip so it is on the first page.
    await page.goto(`/trips?q=${encodeURIComponent(unassignedExternalId)}&scope=all`);

    const row = page.getByRole("row", { name: new RegExp(unassignedExternalId) });
    await expect(row).toBeVisible({ timeout: 15_000 });
    // The quick-assign action (pt-BR "Atribuir") for assign_resources holders on an assignable trip.
    await row.getByRole("button", { name: "Atribuir" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});

test.describe("US5 — Home Dashboard unassigned-trips widget", () => {
  test("the 'Viagens sem atribuição' widget shows a count and deep-links to the Unassigned view", async ({
    page,
  }) => {
    await login(page, testAccounts.opsManager);
    await page.goto(routes.home);

    // The unassigned-trips widget card title (Trips.dashboard.unassignedTrips).
    await expect(page.getByText("Viagens sem atribuição", { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // The unassigned widget's "Ver na Torre de Controle" deep-link is the ONLY one carrying the
    // Unassigned-view query (?assigned=false…); the other widget deep-links use different params.
    const deepLink = page.locator('a[href*="assigned=false"]', { hasText: "Ver na Torre de Controle" });
    await expect(deepLink).toBeVisible();
    await expect(deepLink).toHaveAttribute("href", /assigned=false/);
  });
});
