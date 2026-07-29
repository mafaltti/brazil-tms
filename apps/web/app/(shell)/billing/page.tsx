import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { getTripFilterOptions } from "@/lib/trips/trips-read";
import { BillingLists } from "@/components/billing/billing-lists";
import { ExportPanel } from "@/components/billing/export-panel";

/**
 * Billing screen (008, US5, §15.10). Server guard reuses `view_all_trips` (all seven internal roles
 * read the lists + export history). The export action + file download stay gated `export_billing` at
 * the BFF. Customer options loaded here. Polling, no Realtime.
 */
export default async function BillingPage() {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "view_all_trips")) redirect("/");

  const t = await getTranslations("Billing");
  const options = await getTripFilterOptions();

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">{t("screenTitle")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </header>
      <BillingLists options={options} />
      <ExportPanel options={options} />
    </div>
  );
}
