import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { FreightRatesClient } from "@/components/freight-rates/freight-rates-client";

/**
 * Tabela de Fretes — agregados freight rate lookup (016, §15.13). Server guard ENFORCES
 * `view_freight_rates` (the 7 internal roles); the upload action additionally requires
 * `import_freight_rates` (Admin / Finance), decided here and enforced again by the BFF.
 */
export default async function FreightRatesPage() {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "view_freight_rates")) redirect("/");

  const t = await getTranslations("FreightRates");

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">{t("screenTitle")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </header>
      <FreightRatesClient canImport={can(session.user.role, "import_freight_rates")} />
    </div>
  );
}
