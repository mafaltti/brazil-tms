import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db, statusMappings } from "@brazil-tms/db";
import { TRIP_STATUSES, type TripStatus } from "@brazil-tms/shared";
import { writeAudit } from "@/lib/audit/write-audit";
import { Conflict } from "@/lib/api/respond";

/** API response shape for a status mapping (contract: bff-endpoints.md §status-mappings). */
export interface StatusMappingDto {
  id: string;
  customerId: string;
  customerLabel: string;
  internalStatus: TripStatus;
  active: boolean;
}

interface StatusMappingRow {
  id: string;
  customerId: string;
  customerLabel: string;
  internalStatus: TripStatus;
  active: boolean;
}

function toDto(row: StatusMappingRow): StatusMappingDto {
  return {
    id: row.id,
    customerId: row.customerId,
    customerLabel: row.customerLabel,
    internalStatus: row.internalStatus,
    active: row.active,
  };
}

function isTripStatus(value: string): value is TripStatus {
  return (TRIP_STATUSES as readonly string[]).includes(value);
}

export interface ListStatusMappingsOptions {
  customerId: string;
  includeArchived?: boolean;
}

export async function listStatusMappings(
  opts: ListStatusMappingsOptions,
): Promise<StatusMappingDto[]> {
  const filters = [eq(statusMappings.customerId, opts.customerId)];
  if (!opts.includeArchived) filters.push(isNull(statusMappings.archivedAt));
  const rows = await db
    .select()
    .from(statusMappings)
    .where(and(...filters))
    .orderBy(asc(statusMappings.customerLabel));
  return rows.map(toDto);
}

export interface UpsertStatusMappingInput {
  customerId: string;
  customerLabel: string;
  internalStatus: string;
}

export async function upsertStatusMapping(
  input: UpsertStatusMappingInput,
  actorUserId: string,
): Promise<StatusMappingDto> {
  // Defend in depth: the route Zod-validates `internalStatus` against TRIP_STATUSES, but reject here too.
  if (!isTripStatus(input.internalStatus)) {
    throw new Conflict("INVALID_STATUS", "Status interno inválido.");
  }
  const internalStatus = input.internalStatus;

  return db.transaction(async (tx) => {
    const upserted = await tx
      .insert(statusMappings)
      .values({
        customerId: input.customerId,
        customerLabel: input.customerLabel,
        internalStatus,
      })
      .onConflictDoUpdate({
        target: [statusMappings.customerId, statusMappings.customerLabel],
        set: {
          internalStatus,
          active: true,
          archivedAt: null,
          updatedAt: new Date(),
        },
      })
      .returning();
    const row = upserted[0];
    if (!row) throw new Error("Upsert de mapeamento de status não retornou linha.");
    await writeAudit(tx, {
      entityType: "status_mapping",
      entityId: row.id,
      action: "status_mapping.upsert",
      previousValue: null,
      newValue: {
        customerId: input.customerId,
        customerLabel: input.customerLabel,
        internalStatus,
      },
      actorUserId,
    });
    return toDto(row);
  });
}
