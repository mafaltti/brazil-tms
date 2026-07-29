import { NextResponse } from "next/server";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { listRows } from "@/lib/imports/import-rows-service";

export const dynamic = "force-dynamic";

/** Parse a positive-integer query param, falling back to `undefined` when absent/invalid. */
function parseIntParam(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** GET /api/imports/:id/rows — preview/validation table (US2/US3, FR-013). Requires `import_trips`. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "import_trips");
    const { id } = await params;

    const url = new URL(request.url);
    const { items, total } = await listRows(id, {
      outcome: url.searchParams.get("outcome") ?? undefined,
      match: url.searchParams.get("match") ?? undefined,
      limit: parseIntParam(url.searchParams.get("limit")),
      offset: parseIntParam(url.searchParams.get("offset")),
    });
    return NextResponse.json({ items, total });
  } catch (error) {
    return handleRouteError(error);
  }
}
