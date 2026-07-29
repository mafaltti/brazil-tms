import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { handleRouteError } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

/** POST /api/auth/sign-out — end the current session (clears session cookies on the response). */
export async function POST(): Promise<NextResponse> {
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handleRouteError(error);
  }
}
