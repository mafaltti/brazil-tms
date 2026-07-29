import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { changePasswordSchema } from "@brazil-tms/shared";
import { db, users } from "@brazil-tms/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError, handleRouteError } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/change-password — set a new password for the signed-in user and clear the
 * must-change flag (FR-013a). Requires an active session. The Supabase `app_metadata` flag is a
 * best-effort mirror of the DB flag; failures there are ignored.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    // The ONLY route allowed while onboarding is incomplete (must change password / pending).
    const ctx = await requireAuth({ allowIncompleteOnboarding: true });
    const body = await request.json();
    const { newPassword } = changePasswordSchema.parse(body);

    const supabase = await createSupabaseServerClient();
    // updateUser reports failures via `{ error }` (it does NOT throw). If the password was not
    // actually changed, do NOT release the user — keep the forced-change flag intact.
    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    if (updateError) {
      return apiError(400, "PASSWORD_UPDATE_FAILED", "Não foi possível alterar a senha.");
    }

    // Clear the forced-change flag. For an invite user completing onboarding, also activate them
    // (pending → active) — invite acceptance via the email link bypasses /api/auth/sign-in.
    await db
      .update(users)
      .set({
        mustChangePassword: false,
        ...(ctx.status === "pending" ? { status: "active" as const, lastLoginAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, ctx.userId));

    try {
      await createSupabaseAdminClient().auth.admin.updateUserById(ctx.userId, {
        app_metadata: { must_change_password: false },
      });
    } catch {
      // Best-effort metadata mirror; the authoritative flag lives in the DB.
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
