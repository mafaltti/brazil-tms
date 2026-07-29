import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { cancelScopeForRole } from "@/lib/trips/cancel-scope";
import { getTripFilterOptions } from "@/lib/trips/trips-read";
import { DispatchBoard } from "@/components/trips/dispatch/dispatch-board";

/**
 * Dispatch Board page (006 US5, §15.6). Server guard ENFORCES the pre-declared `assign_resources`
 * permission for the first time (granted to Admin / Ops Manager / Dispatcher / Fleet Coordinator) —
 * an authenticated user without it is redirected home; the BFF stays authoritative on the writes.
 * The active fleet lists (resource pickers) are loaded HERE, server-side under the same guard, and
 * passed to the client board — the dispatch roles never call the `manage_fleet_data`-gated
 * master-data APIs. Freshness is polling (TanStack Query, 30s) — no Realtime.
 */
export default async function DispatchPage() {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "assign_resources")) redirect("/");

  const t = await getTranslations("Dispatch");
  const resourceOptions = await getTripFilterOptions();
  // 017 — reveal the per-row cancel action per §18 (fleet_coordinator assigns but cannot cancel).
  const cancelScope = cancelScopeForRole(session.user.role);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </header>
      <DispatchBoard resourceOptions={resourceOptions} cancelScope={cancelScope} />
    </div>
  );
}
