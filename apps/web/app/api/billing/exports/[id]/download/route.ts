import { NextResponse } from "next/server";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { apiError, handleRouteError } from "@/lib/api/respond";
import { getExportDownload } from "@/lib/billing/exports";
import { exportsBucket, signedUrl } from "@/lib/supabase/storage";

export const dynamic = "force-dynamic";

const DOWNLOAD_URL_TTL_SECONDS = 60;

/**
 * GET /api/billing/exports/:id/download — a short-lived signed URL to the generated export file (US5).
 * `export_billing` (the export is finance output). `404` if not `completed` / no file yet.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "export_billing");
    const { id } = await params;
    const row = await getExportDownload(id);
    if (!row || row.status !== "completed" || !row.fileStorageKey) {
      return apiError(404, "NOT_FOUND", "Exportação não encontrada ou ainda não concluída.");
    }
    const url = await signedUrl(row.fileStorageKey, DOWNLOAD_URL_TTL_SECONDS, exportsBucket());
    return NextResponse.json({ url });
  } catch (error) {
    return handleRouteError(error);
  }
}
