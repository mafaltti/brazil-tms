import { redirect } from "next/navigation";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { TrailersClient } from "@/components/master-data/trailers-client";

/** Trailers administration (US3). Server guard: no `manage_fleet_data` → home (FR-011/SC-011). */
export default async function TrailersPage() {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "manage_fleet_data")) redirect("/");

  return <TrailersClient canArchive={can(session.user.role, "delete_archive")} />;
}
