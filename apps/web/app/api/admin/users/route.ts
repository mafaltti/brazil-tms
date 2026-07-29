import { NextResponse } from "next/server";
import { createUserSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { createUser, inviteRedirectTo, listUsers } from "@/lib/users/service";

export const dynamic = "force-dynamic";

/** GET /api/admin/users — list all users (FR-012). Requires `manage_users`. */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_users");

    const url = new URL(request.url);
    const search = url.searchParams.get("search") ?? undefined;
    const users = await listUsers({ search });
    return NextResponse.json({ users });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST /api/admin/users — create a user via invite or temporary password (FR-013). */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_users");

    const body = await request.json();
    const input = createUserSchema.parse(body);
    const user = await createUser(input, ctx.userId, inviteRedirectTo(request));
    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
