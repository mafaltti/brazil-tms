import { redirect } from "next/navigation";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { VehicleDetailClient } from "@/components/master-data/vehicle-detail-client";

/** Vehicle create (id="new") / edit (US3). Same guard as the list (FR-011). */
export default async function VehicleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "manage_fleet_data")) redirect("/");

  const { id } = await params;
  return (
    <VehicleDetailClient vehicleId={id} canArchive={can(session.user.role, "delete_archive")} />
  );
}
