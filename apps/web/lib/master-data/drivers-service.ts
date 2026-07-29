import "server-only";
import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { carriers, db, drivers } from "@brazil-tms/db";
import {
  documentExpiryState,
  type CreateDriverInput,
  type DocumentExpiryState,
  type OwnershipType,
  type ResourceStatus,
  type UpdateDriverInput,
} from "@brazil-tms/shared";
import { writeAudit } from "@/lib/audit/write-audit";
import { Conflict } from "@/lib/api/respond";

/**
 * Driver master-data service (US3/US4; data-model §4, contract §Drivers). Mirrors the customers
 * service structure: a flat DTO with ISO timestamps, list/get/create/update/archive, and an audit
 * written in the SAME transaction as every mutation (R10). Two driver-specific concerns: the derived
 * `documentExpiryState` (R9, computed on read from `license_expiry`, never stored) and the ownership/
 * carrier invariant — a CHECK violation (23514) surfaces as `409 OWNERSHIP_CARRIER_MISMATCH`. A status
 * change on PATCH additionally emits `driver.status_change`.
 */
export interface DriverDto {
  id: string;
  name: string;
  phone: string | null;
  /** Issue #28 [0005]: CPF replaced the driver e-mail (the DB `email` column is dormant). */
  cpf: string | null;
  licenseNumber: string | null;
  licenseCategory: string | null;
  licenseExpiry: string | null;
  ownershipType: OwnershipType;
  carrierId: string | null;
  employer: string | null;
  status: ResourceStatus;
  notes: string | null;
  /** Derived (R9), never stored — recomputed on read so it can never drift. */
  documentExpiryState: DocumentExpiryState;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DriverRow {
  id: string;
  name: string;
  phone: string | null;
  cpf: string | null;
  licenseNumber: string | null;
  licenseCategory: string | null;
  licenseExpiry: string | null;
  ownershipType: OwnershipType;
  carrierId: string | null;
  employer: string | null;
  status: ResourceStatus;
  notes: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(row: DriverRow): DriverDto {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    cpf: row.cpf,
    licenseNumber: row.licenseNumber,
    licenseCategory: row.licenseCategory,
    licenseExpiry: row.licenseExpiry,
    ownershipType: row.ownershipType,
    carrierId: row.carrierId,
    employer: row.employer,
    status: row.status,
    notes: row.notes,
    documentExpiryState: documentExpiryState(row.licenseExpiry, new Date()),
    archived: row.archivedAt !== null,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Postgres CHECK-violation SQLSTATE (ownership/carrier invariant → 409). */
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
function isCheckViolation(error: unknown): boolean {
  return pgCode(error) === PG_CHECK_VIOLATION;
}

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

export interface ListDriversOptions {
  q?: string;
  status?: ResourceStatus;
  carrierId?: string;
  ownership?: OwnershipType;
  expiry?: "expiring" | "expired";
  includeArchived?: boolean;
}

export async function listDrivers(opts: ListDriversOptions = {}): Promise<DriverDto[]> {
  const filters = [];
  if (!opts.includeArchived) filters.push(isNull(drivers.archivedAt));
  if (opts.status) filters.push(eq(drivers.status, opts.status));
  if (opts.carrierId) filters.push(eq(drivers.carrierId, opts.carrierId));
  if (opts.ownership) filters.push(eq(drivers.ownershipType, opts.ownership));
  if (opts.q && opts.q.trim().length > 0) {
    const term = `%${opts.q.trim()}%`;
    filters.push(or(ilike(drivers.name, term), ilike(drivers.phone, term)));
  }
  const rows = await db
    .select()
    .from(drivers)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(drivers.createdAt));
  const dtos = rows.map(toDto);
  // Expiry is derived, so filter after mapping (modest volumes — plan: Performance Goals).
  if (opts.expiry) return dtos.filter((d) => d.documentExpiryState === opts.expiry);
  return dtos;
}

export async function getDriver(id: string): Promise<DriverDto> {
  const rows = await db.select().from(drivers).where(eq(drivers.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new Conflict("NOT_FOUND", "Motorista não encontrado.");
  return toDto(row);
}

export async function createDriver(
  input: CreateDriverInput,
  actorUserId: string,
): Promise<DriverDto> {
  if (input.carrierId) await assertActiveCarrier(input.carrierId);
  try {
    return await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(drivers)
        .values({
          name: input.name,
          phone: input.phone ?? null,
          cpf: input.cpf ?? null,
          licenseNumber: input.licenseNumber ?? null,
          licenseCategory: input.licenseCategory ?? null,
          licenseExpiry: input.licenseExpiry ?? null,
          ownershipType: input.ownershipType,
          carrierId: input.carrierId ?? null,
          employer: input.employer ?? null,
          status: input.status ?? "active",
          notes: input.notes ?? null,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("Inserção de motorista não retornou linha.");
      await writeAudit(tx, {
        entityType: "driver",
        entityId: row.id,
        action: "driver.create",
        previousValue: null,
        newValue: { name: input.name, ownershipType: input.ownershipType },
        actorUserId,
      });
      return toDto(row);
    });
  } catch (error) {
    if (isCheckViolation(error)) throw MISMATCH;
    throw error;
  }
}

export async function updateDriver(
  id: string,
  input: UpdateDriverInput,
  actorUserId: string,
): Promise<DriverDto> {
  const currentRows = await db.select().from(drivers).where(eq(drivers.id, id)).limit(1);
  const current = currentRows[0];
  if (!current) throw new Conflict("NOT_FOUND", "Motorista não encontrado.");

  // Build the partial update + before/after snapshots from only the provided fields.
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const previousValue: Record<string, unknown> = {};
  const newValue: Record<string, unknown> = {};
  // Explicit string keys — the refined update schema's `keyof` includes a brand symbol.
  const fields: string[] = [
    "name",
    "phone",
    "cpf",
    "licenseNumber",
    "licenseCategory",
    "licenseExpiry",
    "ownershipType",
    "carrierId",
    "employer",
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

  // A status transition is independently audited as a status_change (RES-007, contract §Drivers).
  const statusChanged = input.status !== undefined && input.status !== current.status;

  try {
    return await db.transaction(async (tx) => {
      const updated = await tx.update(drivers).set(set).where(eq(drivers.id, id)).returning();
      const row = updated[0];
      if (!row) throw new Conflict("NOT_FOUND", "Motorista não encontrado.");
      await writeAudit(tx, {
        entityType: "driver",
        entityId: id,
        action: "driver.update",
        previousValue,
        newValue,
        actorUserId,
      });
      if (statusChanged) {
        await writeAudit(tx, {
          entityType: "driver",
          entityId: id,
          action: "driver.status_change",
          previousValue: { status: current.status },
          newValue: { status: input.status },
          actorUserId,
        });
      }
      return toDto(row);
    });
  } catch (error) {
    if (isCheckViolation(error)) throw MISMATCH;
    throw error;
  }
}

/** Archive (soft-delete) — sets archived_at; never hard-deletes (FR-026). Idempotent. */
export async function archiveDriver(id: string, actorUserId: string): Promise<DriverDto> {
  const currentRows = await db.select().from(drivers).where(eq(drivers.id, id)).limit(1);
  const current = currentRows[0];
  if (!current) throw new Conflict("NOT_FOUND", "Motorista não encontrado.");
  if (current.archivedAt) return toDto(current); // already archived — idempotent, no new audit

  return db.transaction(async (tx) => {
    const now = new Date();
    const updated = await tx
      .update(drivers)
      .set({ archivedAt: now, updatedAt: now })
      .where(eq(drivers.id, id))
      .returning();
    const row = updated[0];
    if (!row) throw new Conflict("NOT_FOUND", "Motorista não encontrado.");
    await writeAudit(tx, {
      entityType: "driver",
      entityId: id,
      action: "driver.archive",
      previousValue: { archivedAt: null },
      newValue: { archivedAt: now.toISOString() },
      actorUserId,
    });
    return toDto(row);
  });
}
