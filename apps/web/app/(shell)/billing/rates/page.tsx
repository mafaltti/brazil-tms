import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { getTripFilterOptions } from "@/lib/trips/trips-read";
import { RateAdmin } from "@/components/billing/rate-admin";

/**
 * Rate admin screen (008, US4, §15.10). Server guard ENFORCES `edit_rates` (Admin / Finance) — a
 * non-holder is redirected home; the BFF stays authoritative. Customer/lane options loaded under the
 * same guard. The toll/waiting/extra-stop rule fields are labeled as gated §29 Input #5.
 */
export default async function RatesPage() {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "edit_rates")) redirect("/");

  const t = await getTranslations("Rates");
  const options = await getTripFilterOptions();

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">{t("screenTitle")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </header>
      <RateAdmin options={options} />
    </div>
  );
}
