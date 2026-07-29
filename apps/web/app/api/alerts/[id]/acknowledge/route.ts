import { NextResponse } from "next/server";
import { acknowledgeAlertSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { acknowledgeAlert } from "@/lib/trips/alerts";

export const dynamic = "force-dynamic";

/**
 * POST /api/alerts/:id/acknowledge — acknowledge an in-app alert (007, US4). Requires `view_all_trips`
 * (read-surface triage — there is no alert write key; acknowledgement is not a domain mutation).
 * 409 STALE_ALERT when the alert already auto-resolved.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "view_all_trips");
    const { id } = await params;
    acknowledgeAlertSchema.parse(await request.json().catch(() => ({})));
    const item = await acknowledgeAlert(id, ctx.userId);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}
