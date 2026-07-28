import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, carriers, db, drivers, trailers, users, vehicles } from "@brazil-tms/db";
import { archiveDriver, createDriver, listDrivers, updateDriver } from "./drivers-service";
import { archiveVehicle, createVehicle, updateVehicle } from "./vehicles-service";
import { archiveTrailer, createTrailer, updateTrailer } from "./trailers-service";

/**
 * Integration test for the three operational resources (US3) against the live dev DB. Static imports
 * per project convention; the Drizzle `db` connects lazily, so importing is safe. The suite skips
 * when DATABASE_URL is unset (e.g. CI without a database) so the default `pnpm test` stays green:
 *   $env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'; pnpm exec vitest run --project web
 *
 * Covers, across drivers/vehicles/trailers: owned-create + audit; duplicate-plate rejection
 * (vehicles/trailers); status-change emits `<entity>.status_change`; derived `documentExpiryState`
 * reflects a past date ('expired'); archive + audit. A carrier is inserted for the subcontracted
 * path. Cleanup deletes audit rows + resource rows, then any carrier created.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("resources-service (integration)", () => {
  let actorId = "";
  const driverIds: string[] = [];
  const vehicleIds: string[] = [];
  const trailerIds: string[] = [];
  const carrierIds: string[] = [];

  beforeAll(async () => {
    const admin = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "admin@braziltransports.com.br"))
      .limit(1);
    actorId = admin[0]?.id ?? "";
    expect(actorId, "seeded admin must exist (run db:seed)").not.toBe("");
  });

  afterAll(async () => {
    // Delete resources (and their audit) before any carrier they reference (FK order).
    for (const id of [...driverIds, ...vehicleIds, ...trailerIds]) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
    }
    for (const id of driverIds) await db.delete(drivers).where(eq(drivers.id, id));
    for (const id of vehicleIds) await db.delete(vehicles).where(eq(vehicles.id, id));
    for (const id of trailerIds) await db.delete(trailers).where(eq(trailers.id, id));
    for (const id of carrierIds) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(carriers).where(eq(carriers.id, id));
    }
  });

  /** Unique BR/Mercosul plate (3 letters + 4 digits) within the schema regex. */
  function plate(): string {
    const letters = String.fromCharCode(
      65 + Math.floor(Math.random() * 26),
      65 + Math.floor(Math.random() * 26),
      65 + Math.floor(Math.random() * 26),
    );
    const digits = String(Math.floor(1000 + Math.random() * 9000));
    return `${letters}${digits}`;
  }

  /** Yesterday as a YYYY-MM-DD date string (drives the 'expired' derived state). */
  function yesterdayIso(): string {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  it("createDriver (owned) inserts the row and emits driver.create", async () => {
    const dto = await createDriver(
      { name: "Motorista Teste", ownershipType: "owned" },
      actorId,
    );
    driverIds.push(dto.id);
    expect(dto.ownershipType).toBe("owned");
    expect(dto.carrierId).toBeNull();
    expect(dto.archived).toBe(false);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, dto.id), eq(auditLogs.action, "driver.create")));
    expect(audits).toHaveLength(1);
  });

  it("driver CPF round-trips on create/update and clears with null (issue #28)", async () => {
    const dto = await createDriver(
      { name: "Motorista CPF", ownershipType: "owned", cpf: "39053344705" },
      actorId,
    );
    driverIds.push(dto.id);
    expect(dto.cpf).toBe("39053344705");

    const updated = await updateDriver(dto.id, { cpf: "52998224725" }, actorId);
    expect(updated.cpf).toBe("52998224725");

    const cleared = await updateDriver(dto.id, { cpf: null }, actorId);
    expect(cleared.cpf).toBeNull();
  });

  it("createVehicle (owned) emits vehicle.create; createTrailer (owned) emits trailer.create", async () => {
    const v = await createVehicle(
      { plate: plate(), vehicleType: "truck", ownershipType: "owned" },
      actorId,
    );
    vehicleIds.push(v.id);
    const t = await createTrailer(
      { plate: plate(), trailerType: "sider", ownershipType: "owned" },
      actorId,
    );
    trailerIds.push(t.id);

    const vAudits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, v.id), eq(auditLogs.action, "vehicle.create")));
    const tAudits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, t.id), eq(auditLogs.action, "trailer.create")));
    expect(vAudits).toHaveLength(1);
    expect(tAudits).toHaveLength(1);
  });

  it("createDriver (subcontracted) links a carrier; ownership invariant holds", async () => {
    const inserted = await db
      .insert(carriers)
      .values({ name: `Transportadora Teste ${Date.now()}` })
      .returning();
    const carrierId = inserted[0]!.id;
    carrierIds.push(carrierId);

    const dto = await createDriver(
      { name: "Motorista Subcontratado", ownershipType: "subcontracted", carrierId },
      actorId,
    );
    driverIds.push(dto.id);
    expect(dto.ownershipType).toBe("subcontracted");
    expect(dto.carrierId).toBe(carrierId);
  });

  it("flips a subcontracted resource back to owned, clearing the carrier (P1)", async () => {
    const carrier = (
      await db.insert(carriers).values({ name: `Flip Carrier ${Date.now()}` }).returning()
    )[0]!;
    carrierIds.push(carrier.id);
    const dto = await createDriver(
      { name: "Flip", ownershipType: "subcontracted", carrierId: carrier.id },
      actorId,
    );
    driverIds.push(dto.id);
    expect(dto.carrierId).toBe(carrier.id);

    // Switch to owned WITHOUT sending carrierId — the service must null it so the DB CHECK passes.
    const owned = await updateDriver(dto.id, { ownershipType: "owned" }, actorId);
    expect(owned.ownershipType).toBe("owned");
    expect(owned.carrierId).toBeNull();
  });

  it("rejects linking a subcontracted resource to an ARCHIVED carrier (P1)", async () => {
    const carrier = (
      await db
        .insert(carriers)
        .values({ name: `Arch Carrier ${Date.now()}`, archivedAt: new Date() })
        .returning()
    )[0]!;
    carrierIds.push(carrier.id);
    await expect(
      createDriver(
        { name: "Bad Link", ownershipType: "subcontracted", carrierId: carrier.id },
        actorId,
      ),
    ).rejects.toMatchObject({ code: "INACTIVE_CARRIER" });
  });

  it("rejects a duplicate vehicle plate with Conflict DUPLICATE_PLATE", async () => {
    const p = plate();
    const first = await createVehicle(
      { plate: p, vehicleType: "van", ownershipType: "owned" },
      actorId,
    );
    vehicleIds.push(first.id);

    await expect(
      createVehicle({ plate: p, vehicleType: "toco", ownershipType: "owned" }, actorId),
    ).rejects.toMatchObject({ code: "DUPLICATE_PLATE" });
  });

  it("rejects a duplicate trailer plate with Conflict DUPLICATE_PLATE", async () => {
    const p = plate();
    const first = await createTrailer(
      { plate: p, trailerType: "bau", ownershipType: "owned" },
      actorId,
    );
    trailerIds.push(first.id);

    await expect(
      createTrailer({ plate: p, trailerType: "tanque", ownershipType: "owned" }, actorId),
    ).rejects.toMatchObject({ code: "DUPLICATE_PLATE" });
  });

  it("a status change on update emits driver.status_change (in addition to driver.update)", async () => {
    const dto = await createDriver({ name: "Para Status", ownershipType: "owned" }, actorId);
    driverIds.push(dto.id);
    expect(dto.status).toBe("active");

    const updated = await updateDriver(dto.id, { status: "maintenance" }, actorId);
    expect(updated.status).toBe("maintenance");

    const statusAudits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, dto.id), eq(auditLogs.action, "driver.status_change")));
    expect(statusAudits).toHaveLength(1);
    const updateAudits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, dto.id), eq(auditLogs.action, "driver.update")));
    expect(updateAudits).toHaveLength(1);
  });

  it("status changes on vehicles and trailers emit *.status_change", async () => {
    const v = await createVehicle(
      { plate: plate(), vehicleType: "truck", ownershipType: "owned" },
      actorId,
    );
    vehicleIds.push(v.id);
    await updateVehicle(v.id, { status: "blocked" }, actorId);
    const vStatus = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, v.id), eq(auditLogs.action, "vehicle.status_change")));
    expect(vStatus).toHaveLength(1);

    const tr = await createTrailer(
      { plate: plate(), trailerType: "sider", ownershipType: "owned" },
      actorId,
    );
    trailerIds.push(tr.id);
    await updateTrailer(tr.id, { status: "inactive" }, actorId);
    const tStatus = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, tr.id), eq(auditLogs.action, "trailer.status_change")));
    expect(tStatus).toHaveLength(1);
  });

  it("documentExpiryState reflects a past expiry date as 'expired'", async () => {
    const driver = await createDriver(
      { name: "CNH Vencida", ownershipType: "owned", licenseExpiry: yesterdayIso() },
      actorId,
    );
    driverIds.push(driver.id);
    expect(driver.documentExpiryState).toBe("expired");

    const vehicle = await createVehicle(
      {
        plate: plate(),
        vehicleType: "truck",
        ownershipType: "owned",
        documentExpiry: yesterdayIso(),
      },
      actorId,
    );
    vehicleIds.push(vehicle.id);
    expect(vehicle.documentExpiryState).toBe("expired");

    const trailer = await createTrailer(
      {
        plate: plate(),
        trailerType: "sider",
        ownershipType: "owned",
        documentExpiry: yesterdayIso(),
      },
      actorId,
    );
    trailerIds.push(trailer.id);
    expect(trailer.documentExpiryState).toBe("expired");
  });

  it("archive sets archived_at and emits archive audits; archived rows leave the active list", async () => {
    const dto = await createDriver({ name: "Para Arquivar", ownershipType: "owned" }, actorId);
    driverIds.push(dto.id);

    const archived = await archiveDriver(dto.id, actorId);
    expect(archived.archived).toBe(true);
    expect(archived.archivedAt).not.toBeNull();

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, dto.id), eq(auditLogs.action, "driver.archive")));
    expect(audits).toHaveLength(1);

    const active = await listDrivers({});
    expect(active.find((d) => d.id === dto.id)).toBeUndefined();
    const all = await listDrivers({ includeArchived: true });
    expect(all.find((d) => d.id === dto.id)).toBeDefined();

    // Vehicle + trailer archive (audit) for completeness.
    const v = await createVehicle(
      { plate: plate(), vehicleType: "van", ownershipType: "owned" },
      actorId,
    );
    vehicleIds.push(v.id);
    const vArchived = await archiveVehicle(v.id, actorId);
    expect(vArchived.archived).toBe(true);

    const tr = await createTrailer(
      { plate: plate(), trailerType: "bau", ownershipType: "owned" },
      actorId,
    );
    trailerIds.push(tr.id);
    const tArchived = await archiveTrailer(tr.id, actorId);
    expect(tArchived.archived).toBe(true);
  });
});
