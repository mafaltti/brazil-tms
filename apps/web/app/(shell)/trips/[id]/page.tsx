import { redirect } from "next/navigation";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { cancelScopeForRole } from "@/lib/trips/cancel-scope";
import { getTripFilterOptions } from "@/lib/trips/trips-read";
import { TripDetailClient } from "@/components/trips/trip-detail/trip-detail-client";

/**
 * Trip Detail page (005 US2/US3, 006 assignment panel). Server guard: reuses the pre-declared
 * `view_all_trips` permission (enforced for the first time by 005). The 006 assignment pickers need
 * the active fleet lists, so the extended `getTripFilterOptions` is loaded HERE (under the same
 * `view_all_trips` guard) and passed as `resourceOptions` — the dispatch roles never hit the
 * `manage_fleet_data`-gated master-data APIs. Assignment WRITES stay gated on `assign_resources` at
 * the BFF; viewing the panel (read) is `view_all_trips`. Reads/edits flow through the BFF.
 */
export default async function TripDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "view_all_trips")) redirect("/");

  const { id } = await params;
  const resourceOptions = await getTripFilterOptions();
  // 017 — reveal the cancel action per §18 (any | dispatch_phase | none); the BFF re-enforces it.
  const cancelScope = cancelScopeForRole(session.user.role);
  return <TripDetailClient id={id} resourceOptions={resourceOptions} cancelScope={cancelScope} />;
}
