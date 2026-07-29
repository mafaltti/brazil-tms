import "server-only";
import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { customers, db } from "@brazil-tms/db";
import type { Contact, CreateCustomerInput, UpdateCustomerInput } from "@brazil-tms/shared";
import { writeAudit } from "@/lib/audit/write-audit";
import { Conflict } from "@/lib/api/respond";

/** API response shape for a customer (contract: bff-endpoints.md §Customers; timestamps ISO). */
export interface CustomerDto {
  id: string;
  name: string;
  legalName: string | null;
  customerCode: string;
  taxId: string | null;
  contacts: Contact[];
  billingContact: Contact | null;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CustomerRow {
  id: string;
  name: string;
  legalName: string | null;
  customerCode: string;
  taxId: string | null;
  contacts: unknown;
  billingContact: unknown;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(row: CustomerRow): CustomerDto {
  return {
    id: row.id,
    name: row.name,
    legalName: row.legalName,
    customerCode: row.customerCode,
    taxId: row.taxId,
    contacts: (row.contacts as Contact[] | null) ?? [],
    billingContact: (row.billingContact as Contact | null) ?? null,
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

const DUPLICATE = new Conflict("DUPLICATE_CUSTOMER_CODE", "Já existe um cliente com esse código.");

export interface ListCustomersOptions {
  q?: string;
  includeArchived?: boolean;
}

export async function listCustomers(opts: ListCustomersOptions = {}): Promise<CustomerDto[]> {
  const filters = [];
  if (!opts.includeArchived) filters.push(isNull(customers.archivedAt));
  if (opts.q && opts.q.trim().length > 0) {
    const term = `%${opts.q.trim()}%`;
    filters.push(
      or(
        ilike(customers.name, term),
        ilike(customers.customerCode, term),
        ilike(customers.taxId, term),
      ),
    );
  }
  const rows = await db
    .select()
    .from(customers)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(customers.createdAt));
  return rows.map(toDto);
}

export async function getCustomer(id: string): Promise<CustomerDto> {
  const rows = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new Conflict("NOT_FOUND", "Cliente não encontrado.");
  return toDto(row);
}

export async function createCustomer(
  input: CreateCustomerInput,
  actorUserId: string,
): Promise<CustomerDto> {
  try {
    return await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(customers)
        .values({
          name: input.name,
          legalName: input.legalName ?? null,
          customerCode: input.customerCode,
          taxId: input.taxId ?? null,
          contacts: input.contacts ?? [],
          billingContact: input.billingContact ?? null,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("Inserção de cliente não retornou linha.");
      await writeAudit(tx, {
        entityType: "customer",
        entityId: row.id,
        action: "customer.create",
        previousValue: null,
        newValue: { name: input.name, customerCode: input.customerCode },
        actorUserId,
      });
      return toDto(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw DUPLICATE;
    throw error;
  }
}

export async function updateCustomer(
  id: string,
  input: UpdateCustomerInput,
  actorUserId: string,
): Promise<CustomerDto> {
  const currentRows = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
  const current = currentRows[0];
  if (!current) throw new Conflict("NOT_FOUND", "Cliente não encontrado.");

  // Build the partial update + before/after snapshots from only the provided fields.
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const previousValue: Record<string, unknown> = {};
  const newValue: Record<string, unknown> = {};
  const fields: (keyof UpdateCustomerInput)[] = [
    "name",
    "legalName",
    "customerCode",
    "taxId",
    "contacts",
    "billingContact",
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
        .update(customers)
        .set(set)
        .where(eq(customers.id, id))
        .returning();
      const row = updated[0];
      if (!row) throw new Conflict("NOT_FOUND", "Cliente não encontrado.");
      await writeAudit(tx, {
        entityType: "customer",
        entityId: id,
        action: "customer.update",
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
export async function archiveCustomer(id: string, actorUserId: string): Promise<CustomerDto> {
  const currentRows = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
  const current = currentRows[0];
  if (!current) throw new Conflict("NOT_FOUND", "Cliente não encontrado.");
  if (current.archivedAt) return toDto(current); // already archived — idempotent, no new audit

  return db.transaction(async (tx) => {
    const now = new Date();
    const updated = await tx
      .update(customers)
      .set({ archivedAt: now, updatedAt: now })
      .where(eq(customers.id, id))
      .returning();
    const row = updated[0];
    if (!row) throw new Conflict("NOT_FOUND", "Cliente não encontrado.");
    await writeAudit(tx, {
      entityType: "customer",
      entityId: id,
      action: "customer.archive",
      previousValue: { archivedAt: null },
      newValue: { archivedAt: now.toISOString() },
      actorUserId,
    });
    return toDto(row);
  });
}
