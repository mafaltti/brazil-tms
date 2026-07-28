import "server-only";
import { and, desc, eq, ilike, isNull } from "drizzle-orm";
import { carriers, db, vehicles } from "@brazil-tms/db";
import {
  documentExpiryState,
  type CreateVehicleInput,
  type DocumentExpiryState,
  type OwnershipType,
  type ResourceStatus,
  type UpdateVehicleInput,
  type VehicleType,
} from "@brazil-tms/shared";
import { writeAudit } from "@/lib/audit/write-audit";
import { Conflict } from "@/lib/api/respond";

/**
 * Vehicle master-data service (US3/US4; data-model §5, contract §Vehicles). Mirrors drivers; adds the
 * globally-unique `plate` (a 23505 unique violation → `409 DUPLICATE_PLATE`) and the `vehicle_type`
 * code. Ownership/carrier CHECK (23514) → `409 OWNERSHIP_CARRIER_MISMATCH`. Derived
 * `documentExpiryState` (R9) is computed on read from `document_expiry`. A status change on PATCH
 * additionally emits `vehicle.status_change`. Every mutation audits in the same transaction (R10).
 */
export interface VehicleDto {
  id: string;
  plate: string;
  vehicleType: VehicleType;
  /** Brazilian registry identifiers (issue #30 [0007]) — optional, non-unique. */
  anttNumber: string | null;
  renavam: string | null;
  chassis: string | null;
  capacityKg: number | null;
  ownershipType: OwnershipType;
  carrierId: string | null;
  owner: string | null;
  trackerProvider: string | null;
  trackerId: string | null;
  documentExpiry: string | null;
  status: ResourceStatus;
  notes: string | null;
  /** Derived (R9), never stored — recomputed on read so it can never drift. */
  documentExpiryState: DocumentExpiryState;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface VehicleRow {
  id: string;
  plate: string;
  vehicleType: VehicleType;
  anttNumber: string | null;
  renavam: string | null;
  chassis: string | null;
  capacityKg: number | null;
  ownershipType: OwnershipType;
  carrierId: string | null;
  owner: string | null;
  trackerProvider: string | null;
  trackerId: string | null;
  documentExpiry: string | null;
  status: ResourceStatus;
  notes: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(row: VehicleRow): VehicleDto {
  return {
    id: row.id,
    plate: row.plate,
    vehicleType: row.vehicleType,
    anttNumber: row.anttNumber,
    renavam: row.renavam,
    chassis: row.chassis,
    capacityKg: row.capacityKg,
    ownershipType: row.ownershipType,
    carrierId: row.carrierId,
    owner: row.owner,
    trackerProvider: row.trackerProvider,
    trackerId: row.trackerId,
    documentExpiry: row.documentExpiry,
    status: row.status,
    notes: row.notes,
    documentExpiryState: documentExpiryState(row.documentExpiry, new Date()),
    archived: row.archivedAt !== null,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Postgres unique-violation (duplicate plate → 409) and CHECK-violation (ownership/carrier → 409). */
const PG_UNIQUE_VIOLATION = "23505";
const PG_CHECK_VIOLATION = "23514";
function pgCode(error: unknown): string | undefined {
  // Drizzle wraps driver errors (DrizzleQueryError); the pg SQLSTATE lives on the error or its cause.
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    if (typeof candidate === "object" && candidate !== null && "code" in candidate) {
      const code = (candidate as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return undefined;
}

const DUPLICATE_PLATE = new Conflict("DUPLICATE_PLATE", "Já existe um recurso com essa placa.");
const MISMATCH = new Conflict(
  "OWNERSHIP_CARRIER_MISMATCH",
  "Recurso subcontratado exige uma transportadora; recurso próprio não pode ter transportadora.",
);

/** A subcontracted resource must link to an ACTIVE carrier (archived carriers excluded from new links). */
async function assertActiveCarrier(carrierId: string): Promise<void> {
  const rows = await db
    .select({ archivedAt: carriers.archivedAt })
    .from(carriers)
    .where(eq(carriers.id, carrierId))
    .limit(1);
  const row = rows[0];
  if (!row || row.archivedAt !== null) {
    throw new Conflict("INACTIVE_CARRIER", "A transportadora selecionada não está ativa.");
  }
}

/** Map a Postgres driver error to the right BFF Conflict, or rethrow if unrelated. */
function mapWriteError(error: unknown): never {
  const code = pgCode(error);
  if (code === PG_UNIQUE_VIOLATION) throw DUPLICATE_PLATE;
  if (code === PG_CHECK_VIOLATION) throw MISMATCH;
  throw error;
}

export interface ListVehiclesOptions {
  q?: string;
  status?: ResourceStatus;
  vehicleType?: VehicleType;
  carrierId?: string;
  ownership?: OwnershipType;
  expiry?: "expiring" | "expired";
  includeArchived?: boolean;
}

export async function listVehicles(opts: ListVehiclesOptions = {}): Promise<VehicleDto[]> {
  const filters = [];
  if (!opts.includeArchived) filters.push(isNull(vehicles.archivedAt));
  if (opts.status) filters.push(eq(vehicles.status, opts.status));
  if (opts.vehicleType) filters.push(eq(vehicles.vehicleType, opts.vehicleType));
  if (opts.carrierId) filters.push(eq(vehicles.carrierId, opts.carrierId));
  if (opts.ownership) filters.push(eq(vehicles.ownershipType, opts.ownership));
  if (opts.q && opts.q.trim().length > 0) {
    filters.push(ilike(vehicles.plate, `%${opts.q.trim()}%`));
  }
  const rows = await db
    .select()
    .from(vehicles)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(vehicles.createdAt));
  const dtos = rows.map(toDto);
  if (opts.expiry) return dtos.filter((v) => v.documentExpiryState === opts.expiry);
  return dtos;
}

export async function getVehicle(id: string): Promise<VehicleDto> {
  const rows = await db.select().from(vehicles).where(eq(vehicles.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new Conflict("NOT_FOUND", "Veículo não encontrado.");
  return toDto(row);
}

export async function createVehicle(
  input: CreateVehicleInput,
  actorUserId: string,
): Promise<VehicleDto> {
  if (input.carrierId) await assertActiveCarrier(input.carrierId);
  try {
    return await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(vehicles)
        .values({
          plate: input.plate,
          vehicleType: input.vehicleType,
          anttNumber: input.anttNumber ?? null,
          renavam: input.renavam ?? null,
          chassis: input.chassis ?? null,
          capacityKg: input.capacityKg ?? null,
          ownershipType: input.ownershipType,
          carrierId: input.carrierId ?? null,
          owner: input.owner ?? null,
          trackerProvider: input.trackerProvider ?? null,
          trackerId: input.trackerId ?? null,
          documentExpiry: input.documentExpiry ?? null,
          status: input.status ?? "active",
          notes: input.notes ?? null,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("Inserção de veículo não retornou linha.");
      await writeAudit(tx, {
        entityType: "vehicle",
        entityId: row.id,
        action: "vehicle.create",
        previousValue: null,
        newValue: { plate: input.plate, vehicleType: input.vehicleType },
        actorUserId,
      });
      return toDto(row);
    });
  } catch (error) {
    mapWriteError(error);
  }
}

export async function updateVehicle(
  id: string,
  input: UpdateVehicleInput,
  actorUserId: string,
): Promise<VehicleDto> {
  const currentRows = await db.select().from(vehicles).where(eq(vehicles.id, id)).limit(1);
  const current = currentRows[0];
  if (!current) throw new Conflict("NOT_FOUND", "Veículo não encontrado.");

  // Build the partial update + before/after snapshots from only the provided fields.
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const previousValue: Record<string, unknown> = {};
  const newValue: Record<string, unknown> = {};
  // Explicit string keys — the refined update schema's `keyof` includes a brand symbol.
  const fields: string[] = [
    "plate",
    "vehicleType",
    "anttNumber",
    "renavam",
    "chassis",
    "capacityKg",
    "ownershipType",
    "carrierId",
    "owner",
    "trackerProvider",
    "trackerId",
    "documentExpiry",
    "status",
    "notes",
  ];
  const data = input as Record<string, unknown>;
  for (const field of fields) {
    if (data[field] === undefined) continue;
    set[field] = data[field];
    previousValue[field] = (current as Record<string, unknown>)[field] ?? null;
    newValue[field] = data[field];
  }

  // Ownership/carrier coupling (P1): switching to "owned" clears any existing carrier so the DB
  // CHECK is satisfied even when the client omits carrierId.
  if (input.ownershipType === "owned" && current.carrierId !== null) {
    set.carrierId = null;
    previousValue.carrierId = current.carrierId;
    newValue.carrierId = null;
  }
  // A (re)assigned carrier must reference an ACTIVE carrier (unchanged links are not re-checked).
  if ("carrierId" in set && set.carrierId) await assertActiveCarrier(set.carrierId as string);

  const statusChanged = input.status !== undefined && input.status !== current.status;

  try {
    return await db.transaction(async (tx) => {
      const updated = await tx.update(vehicles).set(set).where(eq(vehicles.id, id)).returning();
      const row = updated[0];
      if (!row) throw new Conflict("NOT_FOUND", "Veículo não encontrado.");
      await writeAudit(tx, {
        entityType: "vehicle",
        entityId: id,
        action: "vehicle.update",
        previousValue,
        newValue,
        actorUserId,
      });
      if (statusChanged) {
        await writeAudit(tx, {
          entityType: "vehicle",
          entityId: id,
          action: "vehicle.status_change",
          previousValue: { status: current.status },
          newValue: { status: input.status },
          actorUserId,
        });
      }
      return toDto(row);
    });
  } catch (error) {
    mapWriteError(error);
  }
}

/** Archive (soft-delete) — sets archived_at; never hard-deletes (FR-026). Idempotent. */
export async function archiveVehicle(id: string, actorUserId: string): Promise<VehicleDto> {
  const currentRows = await db.select().from(vehicles).where(eq(vehicles.id, id)).limit(1);
  const current = currentRows[0];
  if (!current) throw new Conflict("NOT_FOUND", "Veículo não encontrado.");
  if (current.archivedAt) return toDto(current); // already archived — idempotent, no new audit

  return db.transaction(async (tx) => {
    const now = new Date();
    const updated = await tx
      .update(vehicles)
      .set({ archivedAt: now, updatedAt: now })
      .where(eq(vehicles.id, id))
      .returning();
    const row = updated[0];
    if (!row) throw new Conflict("NOT_FOUND", "Veículo não encontrado.");
    await writeAudit(tx, {
      entityType: "vehicle",
      entityId: id,
      action: "vehicle.archive",
      previousValue: { archivedAt: null },
      newValue: { archivedAt: now.toISOString() },
      actorUserId,
    });
    return toDto(row);
  });
}
