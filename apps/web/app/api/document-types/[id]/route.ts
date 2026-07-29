import { NextResponse } from "next/server";
import { updateDocumentTypeSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { updateDocumentType } from "@/lib/trips/document-requirements";

export const dynamic = "force-dynamic";

/** PATCH /api/document-types/:id — update a document type (US3). `manage_commercial_data`. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_commercial_data");
    const { id } = await params;
    const input = updateDocumentTypeSchema.parse(await request.json());
    const item = await updateDocumentType(id, input, ctx.userId);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}
