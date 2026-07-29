import { redirect } from "next/navigation";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { TrailerDetailClient } from "@/components/master-data/trailer-detail-client";

/** Trailer create (id="new") / edit (US3). Same guard as the list (FR-011). */
export default async function TrailerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "manage_fleet_data")) redirect("/");

  const { id } = await params;
  return (
    <TrailerDetailClient trailerId={id} canArchive={can(session.user.role, "delete_archive")} />
  );
}
