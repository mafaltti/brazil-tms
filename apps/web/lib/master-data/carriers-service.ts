import "server-only";
import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { carriers, db } from "@brazil-tms/db";
import type { CreateCarrierInput, UpdateCarrierInput } from "@brazil-tms/shared";
import { writeAudit } from "@/lib/audit/write-audit";
import { Conflict } from "@/lib/api/respond";

/** Carrier contact (data-model §7; R8) — distinct from the customer `Contact` (has `address`, no `role`). */
export interface CarrierContact {
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
}

/** API response shape for a carrier (contract: bff-endpoints.md §Carriers; timestamps ISO). */
export interface CarrierDto {
  id: string;
  name: string;
  legalName: string | null;
  taxId: string | null;
  contact: CarrierContact | null;
  contractStatus: string;
  documentationStatus: string;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CarrierRow {
  id: string;
  name: string;
  legalName: string | null;
  taxId: string | null;
  contact: unknown;
  contractStatus: string;
  documentationStatus: string;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(row: CarrierRow): CarrierDto {
  return {
    id: row.id,
    name: row.name,
    legalName: row.legalName,
    taxId: row.taxId,
    contact: (row.contact as CarrierContact | null) ?? null,
    contractStatus: row.contractStatus,
    documentationStatus: row.documentationStatus,
    archived: row.archivedAt !== null,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Postgres unique-violation SQLSTATE (duplicate natural key → 409). */
const PG_UNIQUE_VIOLATION = "23505";
/**
 * Detect a unique-violation. Drizzle wraps the driver error in a `DrizzleQueryError` and puts the
 * original `pg` error (carrying `code: '23505'`) on `.cause`, so we walk the cause chain rather than
 * only inspecting the top-level error.
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      (current as { code?: unknown }).code === PG_UNIQUE_VIOLATION
    ) {
      return true;
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

const DUPLICATE = new Conflict("DUPLICATE_TAX_ID", "Já existe uma transportadora com esse CNPJ.");

export interface ListCarriersOptions {
  q?: string;
  contractStatus?: string;
  includeArchived?: boolean;
}

export async function listCarriers(opts: ListCarriersOptions = {}): Promise<CarrierDto[]> {
  const filters = [];
  if (!opts.includeArchived) filters.push(isNull(carriers.archivedAt));
  if (opts.contractStatus) filters.push(eq(carriers.contractStatus, opts.contractStatus));
  if (opts.q && opts.q.trim().length > 0) {
    const term = `%${opts.q.trim()}%`;
    filters.push(or(ilike(carriers.name, term), ilike(carriers.taxId, term)));
  }
  const rows = await db
    .select()
    .from(carriers)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(carriers.createdAt));
  return rows.map(toDto);
}

export async function getCarrier(id: string): Promise<CarrierDto> {
  const rows = await db.select().from(carriers).where(eq(carriers.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new Conflict("NOT_FOUND", "Transportadora não encontrada.");
  return toDto(row);
}

export async function createCarrier(
  input: CreateCarrierInput,
  actorUserId: string,
): Promise<CarrierDto> {
  try {
    return await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(carriers)
        .values({
          name: input.name,
          legalName: input.legalName ?? null,
          taxId: input.taxId ?? null,
          contact: input.contact ?? null,
          contractStatus: input.contractStatus ?? "active",
          documentationStatus: input.documentationStatus ?? "pending",
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("Inserção de transportadora não retornou linha.");
      await writeAudit(tx, {
        entityType: "carrier",
        entityId: row.id,
        action: "carrier.create",
        previousValue: null,
        newValue: { name: input.name, taxId: input.taxId ?? null },
        actorUserId,
      });
      return toDto(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw DUPLICATE;
    throw error;
  }
}

export async function updateCarrier(
  id: string,
  input: UpdateCarrierInput,
  actorUserId: string,
): Promise<CarrierDto> {
  const currentRows = await db.select().from(carriers).where(eq(carriers.id, id)).limit(1);
  const current = currentRows[0];
  if (!current) throw new Conflict("NOT_FOUND", "Transportadora não encontrada.");

  // Build the partial update + before/after snapshots from only the provided fields.
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const previousValue: Record<string, unknown> = {};
  const newValue: Record<string, unknown> = {};
  const fields: (keyof UpdateCarrierInput)[] = [
    "name",
    "legalName",
    "taxId",
    "contact",
    "contractStatus",
    "documentationStatus",
  ];
  for (const field of fields) {
    if (input[field] === undefined) continue;
    set[field] = input[field];
    previousValue[field] = (current as Record<string, unknown>)[field] ?? null;
    newValue[field] = input[field];
  }

  try {
    return await db.transaction(async (tx) => {
      const updated = await tx
        .update(carriers)
        .set(set)
        .where(eq(carriers.id, id))
        .returning();
      const row = updated[0];
      if (!row) throw new Conflict("NOT_FOUND", "Transportadora não encontrada.");
      await writeAudit(tx, {
        entityType: "carrier",
        entityId: id,
        action: "carrier.update",
        previousValue,
        newValue,
        actorUserId,
      });
      return toDto(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw DUPLICATE;
    throw error;
  }
}

/** Archive (soft-delete) — sets archived_at; never hard-deletes (FR-026). Idempotent. */
export async function archiveCarrier(id: string, actorUserId: string): Promise<CarrierDto> {
  const currentRows = await db.select().from(carriers).where(eq(carriers.id, id)).limit(1);
  const current = currentRows[0];
  if (!current) throw new Conflict("NOT_FOUND", "Transportadora não encontrada.");
  if (current.archivedAt) return toDto(current); // already archived — idempotent, no new audit

  return db.transaction(async (tx) => {
    const now = new Date();
    const updated = await tx
      .update(carriers)
      .set({ archivedAt: now, updatedAt: now })
      .where(eq(carriers.id, id))
      .returning();
    const row = updated[0];
    if (!row) throw new Conflict("NOT_FOUND", "Transportadora não encontrada.");
    await writeAudit(tx, {
      entityType: "carrier",
      entityId: id,
      action: "carrier.archive",
      previousValue: { archivedAt: null },
      newValue: { archivedAt: now.toISOString() },
      actorUserId,
    });
    return toDto(row);
  });
}
