import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditLogs,
  customers,
  db,
  documentRequirements,
  documentTypes,
  lanes,
  loadChecklistStatus,
  locations,
  resolveRequiredTypes,
  users,
} from "@brazil-tms/db";
import {
  createDocumentRequirement,
  createDocumentType,
  updateDocumentRequirement,
  updateDocumentType,
} from "./document-requirements";

/**
 * Feature 008 (US3, T078) — document-requirement + document-type CRUD and the additive checklist
 * resolution against the live dev DB. Static imports; skips when DATABASE_URL is unset.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("document requirements (integration, US3)", () => {
  let actorId = "";
  let customerId = "";
  let emptyCustomerId = "";
  let originId = "";
  let destId = "";
  let laneId = "";
  let typeAId = "";
  let typeBId = "";
  const createdTypeIds: string[] = [];

  function code(p: string): string {
    return `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  beforeAll(async () => {
    const admin = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "admin@braziltransports.com.br"))
      .limit(1);
    actorId = admin[0]?.id ?? "";
    expect(actorId, "seeded admin must exist (run db:seed)").not.toBe("");

    customerId = (
      await db.insert(customers).values({ name: "Cliente Req", customerCode: code("C") }).returning()
    )[0]!.id;
    emptyCustomerId = (
      await db.insert(customers).values({ name: "Cliente Vazio", customerCode: code("CE") }).returning()
    )[0]!.id;
    originId = (
      await db.insert(locations).values({ customerId, code: code("O"), name: "O" }).returning()
    )[0]!.id;
    destId = (
      await db.insert(locations).values({ customerId, code: code("D"), name: "D" }).returning()
    )[0]!.id;
    laneId = (
      await db
        .insert(lanes)
        .values({ customerId, originLocationId: originId, destinationLocationId: destId })
        .returning()
    )[0]!.id;
  });

  afterAll(async () => {
    await db.delete(documentRequirements).where(eq(documentRequirements.customerId, customerId));
    for (const id of createdTypeIds) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
      await db.delete(documentTypes).where(eq(documentTypes.id, id));
    }
    await db.delete(lanes).where(eq(lanes.id, laneId));
    for (const id of [originId, destId]) if (id) await db.delete(locations).where(eq(locations.id, id));
    await db.delete(customers).where(eq(customers.id, customerId));
    await db.delete(customers).where(eq(customers.id, emptyCustomerId));
  });

  it("createDocumentType + updateDocumentType write the row + audit", async () => {
    const created = await createDocumentType({ code: code("dtA"), labelPt: "Tipo A", active: true }, actorId);
    typeAId = created.id;
    createdTypeIds.push(typeAId);
    expect(created.labelPt).toBe("Tipo A");

    const a1 = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, typeAId), eq(auditLogs.action, "document_type.create")));
    expect(a1.length).toBe(1);

    const updated = await updateDocumentType(typeAId, { labelPt: "Tipo A2" }, actorId);
    expect(updated.labelPt).toBe("Tipo A2");
    const a2 = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, typeAId), eq(auditLogs.action, "document_type.update")));
    expect(a2.length).toBe(1);

    const b = await createDocumentType({ code: code("dtB"), labelPt: "Tipo B", active: true }, actorId);
    typeBId = b.id;
    createdTypeIds.push(typeBId);
  });

  it("createDocumentRequirement + updateDocumentRequirement write the row + audit", async () => {
    const created = await createDocumentRequirement(
      { customerId, documentTypeId: typeAId, requiredForCompletion: true, requiredForBilling: true, active: true },
      actorId,
    );
    expect(created.requiredForCompletion).toBe(true);
    const a = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, created.id), eq(auditLogs.action, "document_requirement.create")));
    expect(a.length).toBe(1);

    const updated = await updateDocumentRequirement(created.id, { active: false }, actorId);
    expect(updated.active).toBe(false);
    const a2 = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, created.id), eq(auditLogs.action, "document_requirement.update")));
    expect(a2.length).toBe(1);

    // Re-activate it so the resolution test sees it.
    await updateDocumentRequirement(created.id, { active: true }, actorId);
  });

  it("resolveRequiredTypes applies unscoped + matching scoped rows additively", async () => {
    // typeA = unscoped (already created above). Add typeB scoped to the lane.
    await createDocumentRequirement(
      { customerId, documentTypeId: typeBId, requiredForCompletion: false, requiredForBilling: true, laneId, active: true },
      actorId,
    );

    const onLane = await resolveRequiredTypes({ customerId, laneId, plannedVehicleType: null });
    const onLaneIds = onLane.map((r) => r.documentTypeId).sort();
    expect(onLaneIds).toContain(typeAId);
    expect(onLaneIds).toContain(typeBId); // scoped row applies additively

    const offLane = await resolveRequiredTypes({ customerId, laneId: null, plannedVehicleType: null });
    const offLaneIds = offLane.map((r) => r.documentTypeId);
    expect(offLaneIds).toContain(typeAId);
    expect(offLaneIds).not.toContain(typeBId); // scoped row does NOT apply off-lane
  });

  it("a customer with no requirement rows ⇒ DEFAULT + sign-off blocked", async () => {
    const status = await loadChecklistStatus({
      id: randomUUID(),
      customerId: emptyCustomerId,
      laneId: null,
      plannedVehicleType: null,
    });
    expect(status.hasExplicitChecklist).toBe(false); // running on DEFAULT ⇒ document-checklist sign-off blocked
  });

  it("updating a non-existent requirement / type throws NotFound (404) — no spurious audit", async () => {
    const missingId = randomUUID();
    await expect(updateDocumentRequirement(missingId, { active: false }, actorId)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    await expect(updateDocumentType(missingId, { labelPt: "x" }, actorId)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    // The rolled-back transaction wrote no audit row for the missing id.
    const audit = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.entityId, missingId));
    expect(audit.length).toBe(0);
  });
});
