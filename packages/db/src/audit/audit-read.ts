import { and, count, desc, eq, gte, lt, type SQL } from "drizzle-orm";
import { dayRangeSaoPaulo, type AuditLogPage, type AuditLogQuery, type AuditLogView } from "@brazil-tms/shared";
import { db } from "../client";
import { auditLogs, users } from "../../schema";

/**
 * Feature 009 — the audit-history read model (FR-013/014, US4; data-model §5). EXTENDS the slice-001
 * inline read with `actorUserId` / `from`/`to` date-range / pagination filters and an actor-name join
 * (`users.name`), widening coverage to the §21.5 record types. Reads ONLY `audit_logs` (+ the user
 * join) — append-only, never mutated (Constitution III). Backed by the existing
 * `audit_logs_{entity,actor,created}_idx`; `from`/`to` is a `created_at` BETWEEN range. Newest-first.
 */
export async function queryAuditLog(filters: AuditLogQuery): Promise<AuditLogPage> {
  const conditions: SQL[] = [];
  if (filters.entityType) conditions.push(eq(auditLogs.entityType, filters.entityType));
  if (filters.entityId) conditions.push(eq(auditLogs.entityId, filters.entityId));
  if (filters.action) conditions.push(eq(auditLogs.action, filters.action));
  if (filters.actorUserId) conditions.push(eq(auditLogs.actorUserId, filters.actorUserId));
  // `from`/`to` are SP calendar-day strings → half-open BRT day range, `to` inclusive of its day
  // (mirrors the 005 board's pickup filter), so a date-only filter never drops that day's records.
  if (filters.from) {
    conditions.push(gte(auditLogs.createdAt, new Date(dayRangeSaoPaulo(filters.from).from)));
  }
  if (filters.to) {
    conditions.push(lt(auditLogs.createdAt, new Date(dayRangeSaoPaulo(filters.to).to)));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, totalRows] = await Promise.all([
    db
      .select({
        id: auditLogs.id,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        action: auditLogs.action,
        previousValue: auditLogs.previousValue,
        newValue: auditLogs.newValue,
        actorUserId: auditLogs.actorUserId,
        actorName: users.name,
        reason: auditLogs.reason,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.actorUserId, users.id))
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(filters.limit)
      .offset(filters.offset),
    db.select({ value: count() }).from(auditLogs).where(where),
  ]);

  const items: AuditLogView[] = rows.map((r) => ({
    id: r.id,
    entityType: r.entityType,
    entityId: r.entityId,
    action: r.action,
    previousValue: r.previousValue as Record<string, unknown> | null,
    newValue: r.newValue as Record<string, unknown> | null,
    actorUserId: r.actorUserId,
    actorName: r.actorName,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  }));

  return { items, total: totalRows[0]?.value ?? 0 };
}
