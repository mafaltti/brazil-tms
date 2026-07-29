import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { getTripFilterOptions } from "@/lib/trips/trips-read";
import { SlaRuleAdmin } from "@/components/sla-rules/sla-rule-admin";

/**
 * Per-customer SLA-rule admin screen (007, US5, §13). Server guard ENFORCES the reused
 * `manage_commercial_data` key (Admin / Ops Manager) — a non-holder is redirected home; the BFF stays
 * authoritative on the writes. Customer/lane options are loaded here under the same guard. The screen
 * surfaces "SLA sign-off blocked" for customers with no rule (running on the company default policy).
 */
export default async function SlaRulesPage() {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "manage_commercial_data")) redirect("/");

  const t = await getTranslations("Sla.rules");
  const options = await getTripFilterOptions();

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </header>
      <SlaRuleAdmin options={options} />
    </div>
  );
}
