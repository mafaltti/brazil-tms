import "server-only";
import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { customers, db, locations } from "@brazil-tms/db";
import type { CreateLocationInput, UpdateLocationInput } from "@brazil-tms/shared";
import { writeAudit } from "@/lib/audit/write-audit";
import { Conflict } from "@/lib/api/respond";

/** API response shape for a location (contract: bff-endpoints.md §Locations; timestamps ISO). */
export interface LocationDto {
  id: string;
  customerId: string;
  code: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string;
  latitude: number | null;
  longitude: number | null;
  gateInstructions: string | null;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface LocationRow {
  id: string;
  customerId: string;
  code: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string;
  latitude: number | null;
  longitude: number | null;
  gateInstructions: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(row: LocationRow): LocationDto {
  return {
    id: row.id,
    customerId: row.customerId,
    code: row.code,
    name: row.name,
    address: row.address,
    city: row.city,
    state: row.state,
    country: row.country,
    latitude: row.latitude,
    longitude: row.longitude,
    gateInstructions: row.gateInstructions,
    archived: row.archivedAt !== null,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Postgres unique-violation SQLSTATE (duplicate natural key → 409). */
const PG_UNIQUE_VIOLATION = "23505";
/**
 * Detect a Postgres unique-violation. Drizzle wraps the driver error in a `DrizzleQueryError`
 * and carries the original `pg` error (with `code: '23505'`) on `.cause`, so we walk the cause
 * chain rather than only inspecting the top-level error.
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

/** `(customer_id, code)` is unique per customer → duplicate code within a customer. */
const DUPLICATE = new Conflict(
  "DUPLICATE_LOCATION_CODE",
  "Já existe um local com esse código para o cliente.",
);

/**
 * A location must reference an ACTIVE customer. Archived parents are excluded from *new* links
 * (data-model.md §Relationships); the UI filters its picker, but the BFF is the authoritative gate.
 */
async function assertActiveCustomer(customerId: string): Promise<void> {
  const rows = await db
    .select({ archivedAt: customers.archivedAt })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  const row = rows[0];
  if (!row || row.archivedAt !== null) {
    throw new Conflict("INACTIVE_CUSTOMER", "O cliente selecionado não está ativo.");
  }
}

export interface ListLocationsOptions {
  customerId?: string;
  q?: string;
  includeArchived?: boolean;
}

export async function listLocations(opts: ListLocationsOptions = {}): Promise<LocationDto[]> {
  const filters = [];
  if (!opts.includeArchived) filters.push(isNull(locations.archivedAt));
  if (opts.customerId) filters.push(eq(locations.customerId, opts.customerId));
  if (opts.q && opts.q.trim().length > 0) {
    const term = `%${opts.q.trim()}%`;
    filters.push(or(ilike(locations.code, term), ilike(locations.name, term)));
  }
  const rows = await db
    .select()
    .from(locations)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(locations.createdAt));
  return rows.map(toDto);
}

export async function getLocation(id: string): Promise<LocationDto> {
  const rows = await db.select().from(locations).where(eq(locations.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new Conflict("NOT_FOUND", "Local não encontrado.");
  return toDto(row);
}

export async function createLocation(
  input: CreateLocationInput,
  actorUserId: string,
): Promise<LocationDto> {
  await assertActiveCustomer(input.customerId);
  try {
    return await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(locations)
        .values({
          customerId: input.customerId,
          code: input.code,
          name: input.name,
          address: input.address ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          country: input.country,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          gateInstructions: input.gateInstructions ?? null,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("Inserção de local não retornou linha.");
      await writeAudit(tx, {
        entityType: "location",
        entityId: row.id,
        action: "location.create",
        previousValue: null,
        newValue: { customerId: input.customerId, code: input.code, name: input.name },
        actorUserId,
      });
      return toDto(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw DUPLICATE;
    throw error;
  }
}

export async function updateLocation(
  id: string,
  input: UpdateLocationInput,
  actorUserId: string,
): Promise<LocationDto> {
  const currentRows = await db.select().from(locations).where(eq(locations.id, id)).limit(1);
  const current = currentRows[0];
  if (!current) throw new Conflict("NOT_FOUND", "Local não encontrado.");

  // Re-pointing a location to a different customer must target an ACTIVE customer.
  if (input.customerId !== undefined) await assertActiveCustomer(input.customerId);

  // Build the partial update + before/after snapshots from only the provided fields.
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const previousValue: Record<string, unknown> = {};
  const newValue: Record<string, unknown> = {};
  const fields: (keyof UpdateLocationInput)[] = [
    "customerId",
    "code",
    "name",
    "address",
    "city",
    "state",
    "country",
    "latitude",
    "longitude",
    "gateInstructions",
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
        .update(locations)
        .set(set)
        .where(eq(locations.id, id))
        .returning();
      const row = updated[0];
      if (!row) throw new Conflict("NOT_FOUND", "Local não encontrado.");
      await writeAudit(tx, {
        entityType: "location",
        entityId: id,
        action: "location.update",
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
export async function archiveLocation(id: string, actorUserId: string): Promise<LocationDto> {
  const currentRows = await db.select().from(locations).where(eq(locations.id, id)).limit(1);
  const current = currentRows[0];
  if (!current) throw new Conflict("NOT_FOUND", "Local não encontrado.");
  if (current.archivedAt) return toDto(current); // already archived — idempotent, no new audit

  return db.transaction(async (tx) => {
    const now = new Date();
    const updated = await tx
      .update(locations)
      .set({ archivedAt: now, updatedAt: now })
      .where(eq(locations.id, id))
      .returning();
    const row = updated[0];
    if (!row) throw new Conflict("NOT_FOUND", "Local não encontrado.");
    await writeAudit(tx, {
      entityType: "location",
      entityId: id,
      action: "location.archive",
      previousValue: { archivedAt: null },
      newValue: { archivedAt: now.toISOString() },
      actorUserId,
    });
    return toDto(row);
  });
}
