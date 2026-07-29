import { redirect } from "next/navigation";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { CarriersClient } from "@/components/master-data/carriers-client";

/** Carriers administration (US4). Server guard: no `manage_fleet_data` → home (FR-011/SC-011). */
export default async function CarriersPage() {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "manage_fleet_data")) redirect("/");

  return <CarriersClient canArchive={can(session.user.role, "delete_archive")} />;
}
