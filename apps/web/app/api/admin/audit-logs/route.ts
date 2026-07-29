import { NextResponse } from "next/server";
import { auditLogFromParams } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { queryAuditLog } from "@/lib/audit/audit-read";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/audit-logs — Admin-only read of the immutable audit trail (slice 001; EXTENDED by 009,
 * US4 / contracts §4). Append-only: this route exposes NO write/update/delete handler. Filters
 * (entityType, entityId, action, actorUserId, from, to) narrow the result; newest-first, paginated
 * (limit/offset). Returns `{ items, total }` with the actor name joined. A denied request (401/403 via
 * handleRouteError) causes no state change (SC-003). Permission unchanged: `view_audit_log`.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "view_audit_log");
    const filters = auditLogFromParams(new URL(request.url).searchParams);
    const page = await queryAuditLog(filters);
    return NextResponse.json(page);
  } catch (error) {
    return handleRouteError(error);
  }
}
