import type { NextResponse } from "next/server";
import { handleResourceDocumentDownload } from "@/lib/master-data/resource-documents-routes";

export const dynamic = "force-dynamic";

/** Slice 025 — signed download URL for one driver attachment (`manage_fleet_data`). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; docId: string }> },
): Promise<NextResponse> {
  const { id, docId } = await params;
  return handleResourceDocumentDownload("driver", id, docId);
}
