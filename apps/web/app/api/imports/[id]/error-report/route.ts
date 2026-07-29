import { NextResponse } from "next/server";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { errorReportUrl } from "@/lib/imports/import-batches-service";

export const dynamic = "force-dynamic";

/**
 * GET /api/imports/:id/error-report — server-mediated download of a batch's generated error report
 * (US2, FR-014). Mints a short-lived signed URL (service-role; no public object URL, R12) and
 * **302-redirects** to it, so the client can use a plain link/navigation. This deliberately avoids the
 * old `{ url }` + client `window.open` pattern, which browsers silently popup-block when the open
 * happens after an `await`. The signed URL never reaches client JS and is freshly minted per request.
 * Requires `import_trips`; `404` when the batch has no error report (not a business conflict, so it
 * does not flow through Conflict).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "import_trips");
    const { id } = await params;
    const url = await errorReportUrl(id);
    if (!url) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Nenhum relatório de erros disponível." } },
        { status: 404 },
      );
    }
    return NextResponse.redirect(url, 302);
  } catch (error) {
    return handleRouteError(error);
  }
}
