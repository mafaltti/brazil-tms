import { NextResponse } from "next/server";
import { createCustomerSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { createCustomer, listCustomers } from "@/lib/master-data/customers-service";

export const dynamic = "force-dynamic";

/** GET /api/master-data/customers — list (US1). Requires `manage_commercial_data`. */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_commercial_data");

    const url = new URL(request.url);
    const items = await listCustomers({
      q: url.searchParams.get("q") ?? undefined,
      includeArchived: url.searchParams.get("includeArchived") === "true",
    });
    return NextResponse.json({ items });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST /api/master-data/customers — create (FR-001, FR-002). Requires `manage_commercial_data`. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_commercial_data");

    const input = createCustomerSchema.parse(await request.json());
    const item = await createCustomer(input, ctx.userId);
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
