import { redirect } from "next/navigation";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { VehiclesClient } from "@/components/master-data/vehicles-client";

/** Vehicles administration (US3). Server guard: no `manage_fleet_data` → home (FR-011/SC-011). */
export default async function VehiclesPage() {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "manage_fleet_data")) redirect("/");

  return <VehiclesClient canArchive={can(session.user.role, "delete_archive")} />;
}
