import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { resolveLocation } from "@/lib/imports/location-aliases-service";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  fileValue: z.string().min(1),
  locationId: z.string().uuid(),
});

/**
 * POST /api/imports/:id/locations — resolve a flagged unknown location by mapping a file value to an
 * existing active location of the batch's customer (US4, FR-025/FR-026). Creates a `location_aliases`
 * row and re-validates the batch; NEVER creates a master-data location. Requires `import_trips`.
 * `409 INVALID_LOCATION_REFERENCE` when the target is archived or belongs to another customer.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "import_trips");
    const { id } = await params;
    const body = bodySchema.parse(await request.json());
    const result = await resolveLocation(id, body, ctx.userId);
    return NextResponse.json({ id: result.id }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
