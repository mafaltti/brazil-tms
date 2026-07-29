import { redirect } from "next/navigation";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { LaneDetailClient } from "@/components/master-data/lane-detail-client";

/** Lane create (id="new") / edit (US2). Same guard as the list (FR-011). */
export default async function LaneDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "manage_commercial_data")) redirect("/");

  const { id } = await params;
  return <LaneDetailClient laneId={id} canArchive={can(session.user.role, "delete_archive")} />;
}
