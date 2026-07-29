import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { loginSchema } from "@brazil-tms/shared";
import { db, users } from "@brazil-tms/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError, handleRouteError } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/sign-in — credential sign-in (FR-001..FR-003).
 * Auth failures are reported generically (no account-existence disclosure). Disabled accounts are
 * denied and their session torn down; first sign-in of a pending account activates it. The session
 * cookies are set on the response automatically by the cookie-bound Supabase client.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { email, password } = loginSchema.parse(body);

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.user) {
      return apiError(401, "INVALID_CREDENTIALS", "E-mail ou senha inválidos.");
    }

    const authUser = data.user;
    const rows = await db.select().from(users).where(eq(users.id, authUser.id)).limit(1);
    const profile = rows[0];
    if (!profile) {
      // Authenticated in GoTrue but no application profile — treat as invalid (no disclosure).
      await supabase.auth.signOut();
      return apiError(401, "INVALID_CREDENTIALS", "E-mail ou senha inválidos.");
    }

    if (profile.status === "disabled") {
      await supabase.auth.signOut();
      return apiError(403, "DISABLED", "Sua conta está desativada. Contate um administrador.");
    }

    const now = new Date();
    if (profile.status === "pending") {
      await db
        .update(users)
        .set({ status: "active", lastLoginAt: now })
        .where(and(eq(users.id, profile.id), eq(users.status, "pending")));
    } else {
      await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, profile.id));
    }

    const redirectTo = profile.mustChangePassword ? "/auth/set-password" : "/";
    return NextResponse.json({ redirectTo });
  } catch (error) {
    return handleRouteError(error);
  }
}
