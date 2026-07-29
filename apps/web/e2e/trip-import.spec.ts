import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  customers,
  db,
  importBatches,
  locations,
  trips,
  users,
} from "@brazil-tms/db";
import { testAccounts, routes } from "./test-config";

/**
 * Feature 004 US1 + slice 013 — Trip Import critical path + endpoint authorization.
 *
 * Authorization is the deterministic core: every import endpoint requires `import_trips`
 * (Admin + Ops Manager only — contracts/permission-matrix.md). No session → 401; an authenticated
 * role lacking the key → 403 (FR-009, unchanged). The happy path drives the BFF fast path — slice 013:
 * the operator sends ONLY customer + file (no template), the batch is created with `templateId: null`,
 * and it never fails for "no template" (FR-005). The worker-driven validate→confirm path and the
 * per-row mapping reasons are covered by the worker integration tests (a separate worker process is
 * required to drain pg-boss) + the quickstart manual walk; the e2e webServer boots only the Next app.
 */

const IMPORTS = "/api/imports";
const TEMPLATES = "/api/import-templates";
const STATUS_MAPPINGS = "/api/status-mappings";
const SOME_UUID = "00000000-0000-0000-0000-000000000000";

async function signIn(page: Page, account: { email: string; password: string }): Promise<void> {
  await page.goto(routes.login);
  await page.getByLabel(/e-?mail/i).fill(account.email);
  await page.getByLabel(/senha/i).fill(account.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith(routes.login), { timeout: 15_000 });
}

async function apiLogin(
  request: APIRequestContext,
  account: { email: string; password: string },
): Promise<APIRequestContext> {
  const res = await request.post("/api/auth/sign-in", {
    data: { email: account.email, password: account.password },
  });
  expect(res.ok()).toBeTruthy();
  return request;
}

test.describe("US1 — import endpoint authorization", () => {
  test("no session → 401 on import endpoints", async ({ request }) => {
    expect((await request.get(IMPORTS)).status()).toBe(401);
    expect((await request.get(TEMPLATES)).status()).toBe(401);
    expect((await request.post(IMPORTS, { multipart: { customerId: SOME_UUID } })).status()).toBe(
      401,
    );
  });

  test("a role without import_trips → 403 (Dispatcher, Finance)", async ({ playwright }) => {
    for (const account of [testAccounts.dispatcher, testAccounts.nonAdmin]) {
      const ctx = await playwright.request.newContext();
      await apiLogin(ctx, account);
      expect((await ctx.get(IMPORTS)).status()).toBe(403);
      expect((await ctx.get(TEMPLATES)).status()).toBe(403);
      expect((await ctx.get(`${STATUS_MAPPINGS}?customerId=${SOME_UUID}`)).status()).toBe(403);
      expect((await ctx.post(`${IMPORTS}/${SOME_UUID}/confirm`)).status()).toBe(403);
      // FR-009: the upload itself stays gated on `import_trips` after slice 013 (no template needed).
      expect((await ctx.post(IMPORTS, { multipart: { customerId: SOME_UUID } })).status()).toBe(403);
      await ctx.dispose();
    }
  });

  test("Ops Manager (has import_trips) → 200 on the batch list", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    expect((await ctx.get(IMPORTS)).status()).toBe(200);
  });
});

test.describe("US1/US2 — Trip Import screen (no template step + provisional banner)", () => {
  test("the screen renders with NO template control (FR-001)", async ({ page }) => {
    await signIn(page, testAccounts.opsManager);
    await page.goto("/imports");
    await expect(page.getByRole("heading", { name: /importar viagens/i })).toBeVisible();
    await expect(page.getByLabel("Cliente").first()).toBeVisible();
    // The template "Modelo de importação" control is gone (slice 013).
    await expect(page.getByText("Modelo de importação")).toHaveCount(0);
  });

  test("the provisional standard-format banner is visible on /imports (US2, FR-007)", async ({
    page,
  }) => {
    await signIn(page, testAccounts.opsManager);
    await page.goto("/imports");
    await expect(
      page.getByText(/formato de importação padrão provisório/i),
    ).toBeVisible();
  });
});

test.describe("US1/US3 — upload fast path (predefined standard format)", () => {
  async function ensureCustomerId(ctx: APIRequestContext): Promise<string> {
    const list = await (await ctx.get("/api/master-data/customers")).json();
    const existing: string | undefined = list.items?.[0]?.id;
    if (existing) return existing;
    const created = await ctx.post("/api/master-data/customers", {
      data: { name: "E2E Import Co", customerCode: `E2E-${Date.now()}`, contacts: [] },
    });
    return (await created.json()).item.id;
  }

  test("upload with NO template returns 202 and a non-failed batch (CSV + XLSX)", async ({
    request,
  }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const customerId = await ensureCustomerId(ctx);

    // Standard-format CSV — posted with ONLY customerId + file (no templateId). The predefined format
    // is applied automatically; the worker-driven mapping/preview is covered by the worker tests.
    const csv =
      "id_viagem,origem,destino,janela_coleta_inicio,janela_coleta_fim,janela_entrega_inicio,janela_entrega_fim,tipo_veiculo,status\n" +
      "E2E-1,ORIG,DEST,01/06/2026 08:00,01/06/2026 10:00,02/06/2026 08:00,02/06/2026 12:00,Truck,Novo\n";
    const upload = await ctx.post(IMPORTS, {
      multipart: {
        customerId,
        file: { name: "e2e-standard.csv", mimeType: "text/csv", buffer: Buffer.from(csv) },
      },
    });
    expect(upload.status()).toBe(202);
    const { id } = await upload.json();
    expect(id).toBeTruthy();

    const detail = await ctx.get(`${IMPORTS}/${id}`);
    expect(detail.status()).toBe(200);
    const { item } = await detail.json();
    // No template was selected, yet the batch is accepted and NEVER failed for "no template" (FR-005).
    expect(item.templateId).toBeNull();
    expect(item.status).not.toBe("failed");
    expect(["received", "parsing", "validating", "validated"]).toContain(item.status);

    // The same standard format accepts a `.xlsx` upload; the parser is chosen from the extension at parse
    // time (FR-004). At upload the BFF only inspects the extension, so a placeholder buffer suffices here —
    // real XLSX parsing is asserted in the worker integration test.
    const xlsxUpload = await ctx.post(IMPORTS, {
      multipart: {
        customerId,
        file: {
          name: "e2e-standard.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: Buffer.from("placeholder"),
        },
      },
    });
    expect(xlsxUpload.status()).toBe(202);
  });

  test("a wrong-columns file is accepted (no header-level rejection, US3)", async ({ request }) => {
    const ctx = await apiLogin(request, testAccounts.opsManager);
    const customerId = await ensureCustomerId(ctx);

    // Columns that do NOT match the standard format. There is no header-level "wrong format" check (R8):
    // the file is ACCEPTED (202) and the per-row reasons are produced downstream by the worker (asserted
    // in the worker integration tests + quickstart) — it is NOT a 4xx rejection or a silent batch failure.
    const wrong = await ctx.post(IMPORTS, {
      multipart: {
        customerId,
        file: { name: "wrong.csv", mimeType: "text/csv", buffer: Buffer.from("coluna_a,coluna_b\nfoo,bar\n") },
      },
    });
    expect(wrong.status()).toBe(202);
    const wrongDetail = await ctx.get(`${IMPORTS}/${(await wrong.json()).id}`);
    expect((await wrongDetail.json()).item.status).not.toBe("failed");

    // A header-only file is likewise accepted; it yields an empty preview (zero data rows) downstream.
    const headerOnly = await ctx.post(IMPORTS, {
      multipart: {
        customerId,
        file: {
          name: "header-only.csv",
          mimeType: "text/csv",
          buffer: Buffer.from("id_viagem,origem,destino\n"),
        },
      },
    });
    expect(headerOnly.status()).toBe(202);
  });
});

test.describe("US1 — imported trips are born received (slice 015)", () => {
  // The e2e webServer boots ONLY the Next app (no worker), so the worker-driven import→confirm path
  // cannot run here — that a confirm-created trip is born `received` is asserted in the worker
  // integration test (workers/jobs/confirm-import/confirm.test.ts). What this e2e pins is the
  // operator-facing surface: slice 015 collapsed the validation states, so a confirm-created
  // (born-`received`) import trip shows status "Recebida" on the Control Tower and is itself
  // dispatch-ready (no separate "Validada" hop). Seeded directly via @brazil-tms/db, mirroring the
  // dispatch e2e.
  const ADMIN_EMAIL = "admin@braziltransports.com.br";
  let customerId = "";
  let originId = "";
  let destId = "";
  let batchId = "";
  let externalId = "";
  const tripIds: string[] = [];

  function code(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  test.beforeAll(async () => {
    const admin = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, ADMIN_EMAIL))
      .limit(1);
    expect(admin[0]?.id, "seeded admin must exist (run db:seed:e2e)").toBeTruthy();
    const adminId = admin[0]!.id;

    const cust = await db
      .insert(customers)
      .values({ name: "Cliente Import 014", customerCode: code("CUST") })
      .returning({ id: customers.id });
    customerId = cust[0]!.id;
    const origin = await db
      .insert(locations)
      .values({ customerId, code: code("ORIG"), name: "Origem 014" })
      .returning({ id: locations.id });
    originId = origin[0]!.id;
    const dest = await db
      .insert(locations)
      .values({ customerId, code: code("DEST"), name: "Destino 014" })
      .returning({ id: locations.id });
    destId = dest[0]!.id;

    // The import batch this trip was "confirmed" from (provenance; templateId null per slice 013).
    const batch = await db
      .insert(importBatches)
      .values({
        customerId,
        fileName: "import-014.csv",
        storageKey: "n/a",
        uploadedBy: adminId,
        status: "completed",
      })
      .returning({ id: importBatches.id });
    batchId = batch[0]!.id;

    // A confirm-created import trip: born `received` (slice 015), linked to its batch.
    externalId = code("EXT-014");
    const trip = await db
      .insert(trips)
      .values({
        customerId,
        externalTripId: externalId,
        importBatchId: batchId,
        originLocationId: originId,
        destinationLocationId: destId,
        currentStatus: "received",
        originalPlan: { customerId, originLocationId: originId, destinationLocationId: destId },
      })
      .returning({ id: trips.id });
    tripIds.push(trip[0]!.id);
  });

  test.afterAll(async () => {
    if (tripIds.length) {
      await db.delete(auditLogs).where(inArray(auditLogs.entityId, tripIds));
      await db.delete(trips).where(inArray(trips.id, tripIds));
    }
    if (batchId) await db.delete(importBatches).where(eq(importBatches.id, batchId));
    for (const id of [originId, destId]) {
      if (id) await db.delete(locations).where(eq(locations.id, id));
    }
    if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
  });

  test("a confirm-created import trip shows status 'Recebida' on the Control Tower (not 'Validada')", async ({
    page,
  }) => {
    await signIn(page, testAccounts.opsManager);
    await page.goto(`/trips?q=${encodeURIComponent(externalId)}&scope=all`);

    const row = page.getByRole("row", { name: new RegExp(externalId) });
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Slice 015: the status badge shows "Recebida" — imported trips are dispatch-ready at `received`
    // itself; the separate "Validada" hop was collapsed away.
    await expect(row.getByText("Recebida")).toBeVisible();
    await expect(row.getByText("Validada")).toHaveCount(0);
  });
});
