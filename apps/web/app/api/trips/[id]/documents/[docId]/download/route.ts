import { NextResponse } from "next/server";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { apiError, handleRouteError } from "@/lib/api/respond";
import { getDocumentFileKey } from "@/lib/trips/documents";
import { documentsBucket, signedUrl } from "@/lib/supabase/storage";

export const dynamic = "force-dynamic";

/** A short-lived signed download URL (seconds). */
const DOWNLOAD_URL_TTL_SECONDS = 60;

/**
 * GET /api/trips/:id/documents/:docId/download — a short-lived signed URL for the document binary
 * (US1, DOC-006). `view_all_trips`. The service-role key never leaves the server; no public object
 * path. `404` for a missing document or a waiver row with no file.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; docId: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "view_all_trips");
    const { id, docId } = await params;
    const key = await getDocumentFileKey(id, docId);
    if (!key) return apiError(404, "NOT_FOUND", "Documento não encontrado.");
    const url = await signedUrl(key, DOWNLOAD_URL_TTL_SECONDS, documentsBucket());
    return NextResponse.json({ url });
  } catch (error) {
    return handleRouteError(error);
  }
}
