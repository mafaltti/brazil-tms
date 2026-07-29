import { NextResponse } from "next/server";
import { z } from "zod";
import { TRIP_STATUSES } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { listStatusMappings, upsertStatusMapping } from "@/lib/imports/status-mappings-service";

export const dynamic = "force-dynamic";

const listQuerySchema = z.object({
  customerId: z.string().uuid(),
  includeArchived: z.boolean().optional(),
});

const upsertBodySchema = z.object({
  customerId: z.string().uuid(),
  customerLabel: z.string().min(1),
  internalStatus: z.enum(TRIP_STATUSES),
});

/** GET /api/status-mappings — list per-customer status mappings (FR-004). Requires `import_trips`. */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "import_trips");

    const url = new URL(request.url);
    const { customerId, includeArchived } = listQuerySchema.parse({
      customerId: url.searchParams.get("customerId") ?? undefined,
      includeArchived: url.searchParams.get("includeArchived") === "true" ? true : undefined,
    });
    const items = await listStatusMappings({ customerId, includeArchived });
    return NextResponse.json({ items });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST /api/status-mappings — upsert a status mapping (FR-004). Requires `import_trips`. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "import_trips");

    const input = upsertBodySchema.parse(await request.json());
    const item = await upsertStatusMapping(input, ctx.userId);
    return NextResponse.json({ id: item.id, item });
  } catch (error) {
    return handleRouteError(error);
  }
}
