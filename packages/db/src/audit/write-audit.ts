import { auditLogs } from "../../schema";
import type { DB } from "../client";
import type { AuditEntry } from "@brazil-tms/shared";

/** Anything with an `insert` method — the live `db` or a transaction handle (`tx`). */
type Inserter = Pick<DB, "insert">;

/**
 * Append-only audit write. Call inside the SAME transaction as the mutation it records so a
 * critical change can never be "missing" (SC-005). Insert-only by design — this module exposes
 * no update/delete path (FR-019).
 */
export async function writeAudit(tx: Inserter, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLogs).values({
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    previousValue: entry.previousValue,
    newValue: entry.newValue,
    actorUserId: entry.actorUserId,
    reason: entry.reason ?? null,
  });
}
