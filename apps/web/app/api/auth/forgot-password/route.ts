import { NextResponse } from "next/server";
import { forgotPasswordSchema } from "@brazil-tms/shared";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { handleRouteError } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/forgot-password — sends a reset link (FR-004). The response is ALWAYS neutral
 * (`{ ok: true }`) regardless of whether the account exists, to avoid account-existence disclosure.
 * A malformed body still fails Zod validation (400 via handleRouteError).
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { email } = forgotPasswordSchema.parse(body);

    const origin =
      request.headers.get("origin") ?? process.env.NEXT_PUBLIC_SITE_URL ?? new URL(request.url).origin;

    const supabase = await createSupabaseServerClient();
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${origin}/auth/set-password`,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
