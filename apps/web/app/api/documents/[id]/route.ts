import { NextResponse } from "next/server";
import { verifyDocumentSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { archiveDocument, verifyDocument } from "@/lib/trips/documents";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/documents/:id — verify a document (accept / reject / pending). `verify_documents`.
 * Records the verifier + timestamp. → `200 { item: TripDetailView }`.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "verify_documents");
    const { id } = await params;
    const input = verifyDocumentSchema.parse(await request.json());
    const item = await verifyDocument(id, input, ctx.userId);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * DELETE /api/documents/:id — archive a document (soft-delete). `upload_documents` (manage your
 * uploads). → `200 { item: TripDetailView }`.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "upload_documents");
    const { id } = await params;
    const item = await archiveDocument(id, ctx.userId);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}
