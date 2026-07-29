import { NextResponse } from "next/server";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { getBatch } from "@/lib/imports/import-batches-service";

export const dynamic = "force-dynamic";

/**
 * GET /api/imports/:id — the polled batch-progress endpoint (US1/US5, FR-007). Returns the batch
 * status + four outcome counts + error-report availability. Requires `import_trips`; `404` when the
 * batch is unknown (a missing batch is not a business conflict, so it does not flow through Conflict).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "import_trips");
    const { id } = await params;
    const item = await getBatch(id);
    if (!item) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Lote não encontrado." } },
        { status: 404 },
      );
    }
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}
