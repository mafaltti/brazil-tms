import type { NextResponse } from "next/server";
import {
  handleResourceDocumentsList,
  handleResourceDocumentUpload,
} from "@/lib/master-data/resource-documents-routes";

export const dynamic = "force-dynamic";

/** Slice 025 — a driver's registry attachments: GET history / POST upload (`manage_fleet_data`). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  return handleResourceDocumentsList("driver", id);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  return handleResourceDocumentUpload("driver", id, request);
}
