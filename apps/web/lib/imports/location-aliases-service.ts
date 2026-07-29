import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import {
  Conflict,
  db,
  importBatches,
  locationAliases,
  locations,
  writeAudit,
} from "@brazil-tms/db";
import { IMPORT_JOBS } from "@brazil-tms/shared";
import { enqueueImportJob } from "@/lib/imports/queue";

/**
 * Location-alias resolution service (feature 004, T049, US4; FR-025, FR-026, R11). When a row's
 * origin/destination file value did not resolve to an active customer location, an authorized user
 * maps that file value to an EXISTING active location of the batch's customer. The mapping is stored
 * in `location_aliases` (`(customer_id, file_value) → location_id`) so future imports auto-resolve it
 * (the worker's validate consults aliases). Import NEVER creates a master-data location (002 owns
 * that). After committing the alias, we re-enqueue `validate` to re-evaluate the affected rows.
 */

/** Postgres unique-violation SQLSTATE (duplicate `(customer_id, file_value)` → 409). */
const PG_UNIQUE_VIOLATION = "23505";

/**
 * Detect a Postgres unique-violation. Drizzle wraps the driver error in a `DrizzleQueryError` and
 * carries the original `pg` error (with `code: '23505'`) on `.cause`, so we walk the cause chain
 * rather than only inspecting the top-level error (project memory: drizzle_error_cause_code).
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

export interface ResolveLocationInput {
  fileValue: string;
  locationId: string;
}

/**
 * Resolve a flagged unknown location by creating a `location_aliases` row. Validates the target is an
 * existing, non-archived location of the batch's customer (the 002 reference-integrity check), inserts
 * the alias + a `location_alias.create` audit in one tx, then enqueues `validate` to re-check the
 * affected rows. Throws `NOT_FOUND` (no batch), `INVALID_LOCATION_REFERENCE` (archived / other
 * customer), or `DUPLICATE_ALIAS` (the file value is already mapped for this customer).
 */
export async function resolveLocation(
  batchId: string,
  input: ResolveLocationInput,
  actorUserId: string,
): Promise<{ id: string }> {
  // 1) Load the batch → its customer.
  const batchRows = await db
    .select({ customerId: importBatches.customerId })
    .from(importBatches)
    .where(eq(importBatches.id, batchId))
    .limit(1);
  const batch = batchRows[0];
  if (!batch) throw new Conflict("NOT_FOUND", "Lote não encontrado.");

  // 2) Reference-integrity: the target location must exist, be active, and belong to this customer.
  const locationRows = await db
    .select({ id: locations.id })
    .from(locations)
    .where(
      and(
        eq(locations.id, input.locationId),
        eq(locations.customerId, batch.customerId),
        isNull(locations.archivedAt),
      ),
    )
    .limit(1);
  if (!locationRows[0]) {
    throw new Conflict(
      "INVALID_LOCATION_REFERENCE",
      "Local inválido: arquivado ou de outro cliente.",
    );
  }

  // 3) Insert the alias + audit in one tx (DRY: unique violation → 409 via the cause-chain walk).
  let aliasId: string;
  try {
    aliasId = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(locationAliases)
        .values({
          customerId: batch.customerId,
          fileValue: input.fileValue,
          locationId: input.locationId,
          createdBy: actorUserId,
        })
        .returning({ id: locationAliases.id });
      const row = inserted[0];
      if (!row) throw new Error("Inserção de alias de local não retornou linha.");
      await writeAudit(tx, {
        entityType: "location_alias",
        entityId: row.id,
        action: "location_alias.create",
        previousValue: null,
        newValue: { fileValue: input.fileValue, locationId: input.locationId },
        actorUserId,
      });
      return row.id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Conflict("DUPLICATE_ALIAS", "Já existe um mapeamento para esse valor de arquivo.");
    }
    throw error;
  }

  // 4) After commit: re-validate the affected rows (the worker's validate now consults aliases).
  await enqueueImportJob(IMPORT_JOBS.validate, { batchId });

  return { id: aliasId };
}
