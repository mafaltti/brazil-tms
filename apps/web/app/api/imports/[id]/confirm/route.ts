import { NextResponse } from "next/server";
import { Conflict, apiError, handleRouteError } from "@/lib/api/respond";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { confirmBatch } from "@/lib/imports/import-batches-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/imports/:id/confirm — confirm an import (US1/US3, FR-016/027/029). Marks the batch
 * `confirming`, audits `import.confirm`, and enqueues the idempotent confirm job (R8). Requires
 * `import_trips`. Returns `202 { id }`; `404` (unknown batch); `409 NOT_CONFIRMABLE` (preview not ready).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "import_trips");
    const { id } = await params;
    const result = await confirmBatch(id, ctx.userId);
    return NextResponse.json({ id: result.id }, { status: 202 });
  } catch (error) {
    // A missing batch is a 404 per the contract; `confirmBatch` signals it via Conflict("NOT_FOUND"),
    // so remap that one code here (NOT_CONFIRMABLE stays a 409 through handleRouteError).
    if (error instanceof Conflict && error.code === "NOT_FOUND") {
      return apiError(404, "NOT_FOUND", error.message);
    }
    return handleRouteError(error);
  }
}
