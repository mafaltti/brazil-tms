import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { customers, db, lanes, locations } from "@brazil-tms/db";
import type { CreateLaneInput, UpdateLaneInput } from "@brazil-tms/shared";
import { writeAudit } from "@/lib/audit/write-audit";
import { Conflict } from "@/lib/api/respond";

/** API response shape for a lane (contract: bff-endpoints.md §Lanes; money centavos, timestamps ISO). */
export interface LaneDto {
  id: string;
  customerId: string;
  originLocationId: string;
  destinationLocationId: string;
  expectedTransitMinutes: number | null;
  defaultVehicleType: string | null;
  standardRateCents: number | null;
  tollEstimateCents: number | null;
  standardDistanceKm: number | null;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface LaneRow {
  id: string;
  customerId: string;
  originLocationId: string;
  destinationLocationId: string;
  expectedTransitMinutes: number | null;
  defaultVehicleType: string | null;
  standardRateCents: number | null;
  tollEstimateCents: number | null;
  // `numeric` columns come back as strings from the driver; coerced to number in toDto.
  standardDistanceKm: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(row: LaneRow): LaneDto {
  return {
    id: row.id,
    customerId: row.customerId,
    originLocationId: row.originLocationId,
    destinationLocationId: row.destinationLocationId,
    expectedTransitMinutes: row.expectedTransitMinutes,
    defaultVehicleType: row.defaultVehicleType,
    standardRateCents: row.standardRateCents,
    tollEstimateCents: row.tollEstimateCents,
    standardDistanceKm: row.standardDistanceKm === null ? null : Number(row.standardDistanceKm),
    archived: row.archivedAt !== null,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Cross-row integrity (FR-009, R5): can't be a single CHECK because it spans rows. */
const INVALID_LANE_REFERENCE = new Conflict(
  "INVALID_LANE_REFERENCE",
  "Origem/destino devem ser locais ativos do mesmo cliente.",
);

/**
 * Assert the lane's customer/origin/destination form a valid triple (FR-009, R5): all three must be
 * **active** (`archived_at IS NULL`), origin and destination must belong to the **same customer** as
 * the lane, and origin must differ from destination. Throws `INVALID_LANE_REFERENCE` otherwise.
 */
async function assertValidReferences(
  customerId: string,
  originLocationId: string,
  destinationLocationId: string,
): Promise<void> {
  if (originLocationId === destinationLocationId) throw INVALID_LANE_REFERENCE;

  const customerRows = await db
    .select({ id: customers.id, archivedAt: customers.archivedAt })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  const customer = customerRows[0];
  if (!customer || customer.archivedAt !== null) throw INVALID_LANE_REFERENCE;

  const origin = await loadActiveLocation(originLocationId);
  const destination = await loadActiveLocation(destinationLocationId);
  if (origin.customerId !== customerId || destination.customerId !== customerId) {
    throw INVALID_LANE_REFERENCE;
  }
}

async function loadActiveLocation(id: string): Promise<{ customerId: string }> {
  const rows = await db
    .select({ customerId: locations.customerId, archivedAt: locations.archivedAt })
    .from(locations)
    .where(eq(locations.id, id))
    .limit(1);
  const row = rows[0];
  if (!row || row.archivedAt !== null) throw INVALID_LANE_REFERENCE;
  return { customerId: row.customerId };
}

export interface ListLanesOptions {
  customerId?: string;
  originId?: string;
  destinationId?: string;
  includeArchived?: boolean;
}

export async function listLanes(opts: ListLanesOptions = {}): Promise<LaneDto[]> {
  const filters = [];
  if (!opts.includeArchived) filters.push(isNull(lanes.archivedAt));
  if (opts.customerId) filters.push(eq(lanes.customerId, opts.customerId));
  if (opts.originId) filters.push(eq(lanes.originLocationId, opts.originId));
  if (opts.destinationId) filters.push(eq(lanes.destinationLocationId, opts.destinationId));
  const rows = await db
    .select()
    .from(lanes)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(lanes.createdAt));
  return rows.map(toDto);
}

export async function getLane(id: string): Promise<LaneDto> {
  const rows = await db.select().from(lanes).where(eq(lanes.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new Conflict("NOT_FOUND", "Rota não encontrada.");
  return toDto(row);
}

export async function createLane(input: CreateLaneInput, actorUserId: string): Promise<LaneDto> {
  await assertValidReferences(
    input.customerId,
    input.originLocationId,
    input.destinationLocationId,
  );

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(lanes)
      .values({
        customerId: input.customerId,
        originLocationId: input.originLocationId,
        destinationLocationId: input.destinationLocationId,
        expectedTransitMinutes: input.expectedTransitMinutes ?? null,
        defaultVehicleType: input.defaultVehicleType ?? null,
        standardRateCents: input.standardRateCents ?? null,
        tollEstimateCents: input.tollEstimateCents ?? null,
        standardDistanceKm:
          input.standardDistanceKm == null ? null : String(input.standardDistanceKm),
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error("Inserção de rota não retornou linha.");
    await writeAudit(tx, {
      entityType: "lane",
      entityId: row.id,
      action: "lane.create",
      previousValue: null,
      newValue: {
        customerId: input.customerId,
        originLocationId: input.originLocationId,
        destinationLocationId: input.destinationLocationId,
      },
      actorUserId,
    });
    return toDto(row);
  });
}

export async function updateLane(
  id: string,
  input: UpdateLaneInput,
  actorUserId: string,
): Promise<LaneDto> {
  const currentRows = await db.select().from(lanes).where(eq(lanes.id, id)).limit(1);
  const current = currentRows[0];
  if (!current) throw new Conflict("NOT_FOUND", "Rota não encontrada.");

  // Re-validate the (possibly changed) reference triple against the merged values (FR-009, R5).
  await assertValidReferences(
    input.customerId ?? current.customerId,
    input.originLocationId ?? current.originLocationId,
    input.destinationLocationId ?? current.destinationLocationId,
  );

  // Build the partial update + before/after snapshots from only the provided fields.
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const previousValue: Record<string, unknown> = {};
  const newValue: Record<string, unknown> = {};
  const fields: (keyof UpdateLaneInput)[] = [
    "customerId",
    "originLocationId",
    "destinationLocationId",
    "expectedTransitMinutes",
    "defaultVehicleType",
    "standardRateCents",
    "tollEstimateCents",
    "standardDistanceKm",
  ];
  for (const field of fields) {
    if (input[field] === undefined) continue;
    // `numeric` column expects a string at the driver boundary — but only for a real value;
    // a cleared distance must stay SQL NULL, not the string "null".
    set[field] =
      field === "standardDistanceKm" && input[field] != null
        ? String(input[field])
        : input[field];
    previousValue[field] = (current as Record<string, unknown>)[field] ?? null;
    newValue[field] = input[field];
  }

  return db.transaction(async (tx) => {
    const updated = await tx.update(lanes).set(set).where(eq(lanes.id, id)).returning();
    const row = updated[0];
    if (!row) throw new Conflict("NOT_FOUND", "Rota não encontrada.");
    await writeAudit(tx, {
      entityType: "lane",
      entityId: id,
      action: "lane.update",
      previousValue,
      newValue,
      actorUserId,
    });
    return toDto(row);
  });
}

/** Archive (soft-delete) — sets archived_at; never hard-deletes (FR-026). Idempotent. */
export async function archiveLane(id: string, actorUserId: string): Promise<LaneDto> {
  const currentRows = await db.select().from(lanes).where(eq(lanes.id, id)).limit(1);
  const current = currentRows[0];
  if (!current) throw new Conflict("NOT_FOUND", "Rota não encontrada.");
  if (current.archivedAt) return toDto(current); // already archived — idempotent, no new audit

  return db.transaction(async (tx) => {
    const now = new Date();
    const updated = await tx
      .update(lanes)
      .set({ archivedAt: now, updatedAt: now })
      .where(eq(lanes.id, id))
      .returning();
    const row = updated[0];
    if (!row) throw new Conflict("NOT_FOUND", "Rota não encontrada.");
    await writeAudit(tx, {
      entityType: "lane",
      entityId: id,
      action: "lane.archive",
      previousValue: { archivedAt: null },
      newValue: { archivedAt: now.toISOString() },
      actorUserId,
    });
    return toDto(row);
  });
}
