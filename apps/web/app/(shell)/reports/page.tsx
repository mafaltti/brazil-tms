import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { getTripFilterOptions } from "@/lib/trips/trips-read";
import { ReportsClient } from "@/components/reports/reports-client";

/**
 * Reports screen (009, §15.11). Server guard reuses the pre-declared `view_all_trips` key (held by all
 * seven internal roles, mirroring the 005 dashboard) — reports are a read surface, so no new key. The
 * customer/lane filter options load here under the same guard and pass to the client shell; the three
 * report views poll their aggregates (60s, no Realtime). pt-BR throughout.
 */
export default async function ReportsPage() {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "view_all_trips")) redirect("/");

  const t = await getTranslations("Reports");
  const options = await getTripFilterOptions();

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </header>
      <ReportsClient options={options} />
    </div>
  );
}
