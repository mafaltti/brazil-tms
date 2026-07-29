import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { DashboardWidgets } from "@/components/trips/dashboard/widgets";
import { AlertSurface } from "@/components/alerts/alert-surface";

/**
 * Home daily dashboard (US4, §15.2). Server guard enforces `view_all_trips` (held by all 7 internal
 * roles — no functional redirect, but kept for correctness/consistency with the other guarded pages);
 * the client `DashboardWidgets` polls the summary aggregates (60s, no Realtime). The welcome tone is
 * carried by the dashboard title/subtitle, replacing the old static Shell card.
 */
export default async function HomePage() {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "view_all_trips")) redirect("/");

  const t = await getTranslations("Trips.dashboard");

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </header>
      <DashboardWidgets />
      <AlertSurface />
    </div>
  );
}
