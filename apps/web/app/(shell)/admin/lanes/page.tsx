import { redirect } from "next/navigation";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { LanesClient } from "@/components/master-data/lanes-client";

/** Lanes administration (US2). Server guard: no `manage_commercial_data` → home (FR-011/SC-011). */
export default async function LanesPage() {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "manage_commercial_data")) redirect("/");

  return <LanesClient canArchive={can(session.user.role, "delete_archive")} />;
}
