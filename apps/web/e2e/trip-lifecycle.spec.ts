import { test, expect, type Page } from "@playwright/test";
import { and, eq, inArray } from "drizzle-orm";
import {
  alerts,
  auditLogs,
  billingAdjustments,
  billingItems,
  carriers,
  customers,
  db,
  documentRequirements,
  documents,
  documentTypes,
  drivers,
  importBatches,
  importRows,
  locations,
  rates,
  tripAssignments,
  tripEvents,
  trips,
  vehicles,
} from "@brazil-tms/db";
import { testAccounts } from "./test-config";

/**
 * THE FULL CYCLE OF A TRIP — a visual, UI-driven walkthrough (not a CI assertion spec).
 *
 * Starts from the REAL file import (worker-driven) and clicks the trip through the entire 003 status
 * machine on the operator cockpit:
 *
 *   /imports upload → worker parse+validate → confirm → BORN received (slice 015)
 *   → assign → confirm → at_origin → loading → loaded → in_transit → at_destination → unloading
 *   → unloaded → (waive POD + Mark Completed) → billing_pending → (Finance) Mark Billing Ready
 *
 * Paced for watching: `slowMo` + a deliberate linger after each captured stage. A full-page screenshot
 * is saved per stage into `e2e/__artifacts__/lifecycle/` and the whole run is video-recorded.
 *
 * REQUIRES, beyond the Next app on :3000:
 *   • the background WORKER running (pnpm --filter @brazil-tms/workers dev) — it drains the pg-boss
 *     parse/validate/confirm jobs; without it the import never leaves "Recebido".
 *   • the seeded e2e accounts + DATABASE_URL for the test process (used to self-seed + read back).
 *
 * Run it directly (server + worker already up):
 *   $env:DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5433/postgres'
 *   $env:PLAYWRIGHT_BASE_URL='http://localhost:3000'
 *   pnpm --filter @brazil-tms/web exec playwright test e2e/trip-lifecycle.spec.ts --workers=1 --reporter=line
 */

test.use({
  video: "on",
  viewport: { width: 1440, height: 900 },
  // Pace every browser action so the recording is watchable (not a correctness setting).
  launchOptions: { slowMo: 650 },
});

const SHOTS = "e2e/__artifacts__/lifecycle";
const LINGER = 1500; // ms to dwell on each captured stage so a viewer can read it

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

// Seeded identifiers + the unique labels we will click in the UI.
let customerId = "";
let originId = "";
let destId = "";
let originCode = "";
let destCode = "";
let driverId = "";
let vehicleId = "";
let carrierId = "";
let docTypeId = "";
let requirementId = "";
let rateId = "";
let tripId = "";
const tripIds: string[] = [];

const customerName = `Cliente Demo — Ciclo ${Date.now()}`;
const externalImportId = code("DEMO-IMP");
const driverName = `Demo Motorista ${code("D")}`;
const plate = uniquePlate();
const carrierName = `Demo Transportadora ${code("C")}`;
const podLabel = `Comprovante de Entrega (POD) ${code("POD")}`;

test.beforeAll(async () => {
  const cust = await db
    .insert(customers)
    .values({ name: customerName, customerCode: code("CUST") })
    .returning({ id: customers.id });
  customerId = cust[0]!.id;

  originCode = code("CD-SP");
  destCode = code("CD-RJ");
  const origin = await db
    .insert(locations)
    .values({ customerId, code: originCode, name: "CD São Paulo (Origem)" })
    .returning({ id: locations.id });
  originId = origin[0]!.id;
  const dest = await db
    .insert(locations)
    .values({ customerId, code: destCode, name: "CD Rio de Janeiro (Destino)" })
    .returning({ id: locations.id });
  destId = dest[0]!.id;

  // OWNED + active + in-document resources ⇒ a clean assignment (no eligibility findings → no override).
  const drv = await db
    .insert(drivers)
    .values({ name: driverName, ownershipType: "owned", status: "active", licenseExpiry: farFutureDate() })
    .returning({ id: drivers.id });
  driverId = drv[0]!.id;
  const veh = await db
    .insert(vehicles)
    .values({ plate, vehicleType: "truck", ownershipType: "owned", status: "active", documentExpiry: farFutureDate() })
    .returning({ id: vehicles.id });
  vehicleId = veh[0]!.id;
  const car = await db
    .insert(carriers)
    .values({ name: carrierName, contractStatus: "active", documentationStatus: "complete" })
    .returning({ id: carriers.id });
  carrierId = car[0]!.id;

  // An EXPLICIT completion+billing document requirement → deterministic gate (overrides the default
  // checklist), waived through the Billing UI during the demo (shows the proof step of the cycle).
  const dt = await db
    .insert(documentTypes)
    .values({ code: code("DT-POD"), labelPt: podLabel })
    .returning({ id: documentTypes.id });
  docTypeId = dt[0]!.id;
  const req = await db
    .insert(documentRequirements)
    .values({ customerId, documentTypeId: docTypeId, requiredForCompletion: true, requiredForBilling: true })
    .returning({ id: documentRequirements.id });
  requirementId = req[0]!.id;

  // A customer-default rate so completion auto-prices the billing item ⇒ Billing-Ready gate passes.
  const rate = await db
    .insert(rates)
    .values({ customerId, baseAmountCents: 180000 })
    .returning({ id: rates.id });
  rateId = rate[0]!.id;
});

test.afterAll(async () => {
  // Import provenance: import_rows.target_trip_id → trips, so drop the batch (cascades rows) BEFORE trips.
  const batches = await db
    .select({ id: importBatches.id })
    .from(importBatches)
    .where(eq(importBatches.customerId, customerId));
  const batchIds = batches.map((b) => b.id);
  if (batchIds.length) await db.delete(importRows).where(inArray(importRows.importBatchId, batchIds));

  if (tripIds.length) {
    await db.delete(alerts).where(inArray(alerts.tripId, tripIds));
    const items = await db
      .select({ id: billingItems.id })
      .from(billingItems)
      .where(inArray(billingItems.tripId, tripIds));
    const itemIds = items.map((r) => r.id);
    if (itemIds.length) {
      await db.delete(billingAdjustments).where(inArray(billingAdjustments.billingItemId, itemIds));
    }
    await db.delete(billingItems).where(inArray(billingItems.tripId, tripIds));
    await db.delete(documents).where(inArray(documents.tripId, tripIds));
    await db.delete(tripAssignments).where(inArray(tripAssignments.tripId, tripIds));
    await db.delete(tripEvents).where(inArray(tripEvents.tripId, tripIds));
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, tripIds));
    await db.delete(trips).where(inArray(trips.id, tripIds));
  }
  if (batchIds.length) {
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, batchIds));
    await db.delete(importBatches).where(inArray(importBatches.id, batchIds));
  }
  if (requirementId) await db.delete(documentRequirements).where(eq(documentRequirements.id, requirementId));
  if (docTypeId) await db.delete(documentTypes).where(eq(documentTypes.id, docTypeId));
  if (rateId) await db.delete(rates).where(eq(rates.id, rateId));
  if (driverId) await db.delete(drivers).where(eq(drivers.id, driverId));
  if (vehicleId) await db.delete(vehicles).where(eq(vehicles.id, vehicleId));
  if (carrierId) await db.delete(carriers).where(eq(carriers.id, carrierId));
  for (const id of [originId, destId]) if (id) await db.delete(locations).where(eq(locations.id, id));
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

/** UI sign-in through the real login form. */
async function uiLogin(page: Page, account: { email: string; password: string }): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("E-mail", { exact: true }).fill(account.email);
  await page.getByLabel("Senha", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

let shotIndex = 0;
async function shot(page: Page, name: string): Promise<void> {
  shotIndex += 1;
  await page.screenshot({
    path: `${SHOTS}/${String(shotIndex).padStart(2, "0")}-${name}.png`,
    fullPage: true,
  });
  await page.waitForTimeout(LINGER); // dwell so the recording lingers on this stage
}

/** Open a Radix Select by trigger id and pick an option by (substring) label. */
async function pickFromSelect(page: Page, triggerId: string, optionText: string): Promise<void> {
  await page.locator(`[id="${triggerId}"]`).click();
  await page.getByRole("option", { name: optionText, exact: false }).first().click();
}

test("the full cycle of a trip — import → billing-ready, clicked through the real UI", async ({
  page,
}) => {
  test.setTimeout(420_000);

  // Click a Timeline milestone button, then wait for the button that the NEXT legal status surfaces.
  async function milestone(clickName: string, waitName: string) {
    await page.getByRole("button", { name: clickName, exact: true }).click();
    await expect(page.getByRole("button", { name: waitName, exact: true })).toBeVisible({
      timeout: 20_000,
    });
  }

  await uiLogin(page, testAccounts.opsManager);

  // ── 0. IMPORT — upload a standard-format CSV, let the worker parse+validate, then confirm ───────
  await test.step("import a trip from a file", async () => {
    await page.goto("/imports");
    await expect(page.getByRole("heading", { name: /importar viagens/i })).toBeVisible({
      timeout: 20_000,
    });
    await pickFromSelect(page, "import-customer", customerName);

    const csv =
      "id_viagem,origem,destino,janela_coleta_inicio,janela_coleta_fim,janela_entrega_inicio,janela_entrega_fim,tipo_veiculo,status\n" +
      `${externalImportId},${originCode},${destCode},01/09/2026 08:00,01/09/2026 12:00,02/09/2026 08:00,02/09/2026 18:00,truck,Planejada\n`;
    await page
      .locator('[id="import-file"]')
      .setInputFiles({ name: "viagens-shopee.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await page.getByRole("button", { name: "Importar", exact: true }).click();
  });
  await shot(page, "import_uploaded");

  // The worker validates the batch — the Confirm button enables once status = "Validado".
  const confirmImportBtn = page.getByRole("button", { name: "Confirmar importação", exact: true });
  await expect(confirmImportBtn).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByText("Validado", { exact: true })).toBeVisible();
  await shot(page, "import_validated");

  await confirmImportBtn.click();
  await expect(page.getByText(/Importação concluída com sucesso/i)).toBeVisible({ timeout: 60_000 });
  await shot(page, "import_completed");

  // Read back the worker-created trip (born `received`, slice 015).
  await expect
    .poll(
      async () => {
        const rows = await db
          .select({ id: trips.id })
          .from(trips)
          .where(and(eq(trips.customerId, customerId), eq(trips.externalTripId, externalImportId)))
          .limit(1);
        return rows[0]?.id ?? "";
      },
      { timeout: 30_000, message: "import worker should have created the trip" },
    )
    .not.toBe("");
  const created = await db
    .select({ id: trips.id })
    .from(trips)
    .where(and(eq(trips.customerId, customerId), eq(trips.externalTripId, externalImportId)))
    .limit(1);
  tripId = created[0]!.id;
  tripIds.push(tripId);

  // ── 1. Recebida — the imported trip on its detail page (slice 015: born `received`, dispatch-ready) ─
  await page.goto(`/trips/${tripId}`);
  await expect(page.getByText(externalImportId).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Recebida", { exact: true }).first()).toBeVisible();
  await shot(page, "received");

  // ── 2. Assign driver + vehicle + carrier → assigned ───────────────────────────────────────────
  await test.step("assign resources", async () => {
    await pickFromSelect(page, `driver-${tripId}`, driverName);
    await pickFromSelect(page, `vehicle-${tripId}`, plate);
    await pickFromSelect(page, `carrier-${tripId}`, carrierName);
    const assignBtn = page.getByRole("button", { name: "Atribuir", exact: true });
    await expect(assignBtn).toBeEnabled({ timeout: 10_000 });
    await assignBtn.click();
    await expect(
      page.getByRole("button", { name: "Confirmar atribuição", exact: true }),
    ).toBeVisible({ timeout: 20_000 });
  });
  await shot(page, "assigned");

  // ── 3. Confirm the assignment → confirmed ─────────────────────────────────────────────────────
  await page.getByRole("button", { name: "Confirmar atribuição", exact: true }).click();
  await expect(page.getByRole("button", { name: "Na origem", exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await shot(page, "confirmed");

  // ── 4. Execution milestones via the Timeline buttons ──────────────────────────────────────────
  await milestone("Na origem", "Carregando"); // confirmed → at_origin
  await shot(page, "at_origin");
  await milestone("Carregando", "Carregada"); // at_origin → loading
  await shot(page, "loading");
  await milestone("Carregada", "Em trânsito"); // loading → loaded
  await shot(page, "loaded");
  await milestone("Em trânsito", "No destino"); // loaded → in_transit
  await shot(page, "in_transit");
  await milestone("No destino", "Descarregando"); // in_transit → at_destination
  await shot(page, "at_destination");
  await milestone("Descarregando", "Descarregada"); // at_destination → unloading
  await shot(page, "unloading");

  // unloaded — the Billing section now offers "Marcar como concluída".
  await page.getByRole("button", { name: "Descarregada", exact: true }).click();
  await expect(page.getByRole("button", { name: "Marcar como concluída", exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await shot(page, "unloaded");

  // ── 5. Waive the POD proof + Mark Completed → billing_pending ──────────────────────────────────
  await test.step("waive POD + complete", async () => {
    await pickFromSelect(page, "waive-type", podLabel);
    await page.locator('[id="waive-reason"]').fill("POD arquivado fora do sistema (demonstração).");
    await page.getByRole("button", { name: "Dispensar", exact: true }).click();
    await page.getByRole("button", { name: "Marcar como concluída", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Marcar pronta para faturar", exact: true }),
    ).toBeVisible({ timeout: 20_000 });
  });
  await shot(page, "billing_pending");

  // ── 6. Re-login as Finance → Mark Billing Ready → billing_ready ───────────────────────────────
  await page.context().clearCookies();
  await uiLogin(page, testAccounts.nonAdmin); // finance@ holds mark_billing_ready
  await page.goto(`/trips/${tripId}`);
  const billingReadyBtn = page.getByRole("button", { name: "Marcar pronta para faturar", exact: true });
  await expect(billingReadyBtn).toBeVisible({ timeout: 20_000 });
  await billingReadyBtn.click();
  await expect(billingReadyBtn).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByText("Pronta p/ faturar").first()).toBeVisible();
  await shot(page, "billing_ready");
});
