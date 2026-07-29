import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { getTripFilterOptions } from "@/lib/trips/trips-read";
import { RequirementAdmin } from "@/components/documents/requirement-admin";
import { DocumentTypeAdmin } from "@/components/documents/document-type-admin";

/**
 * Per-customer document-requirement + document-type admin screen (008, US3). Server guard ENFORCES the
 * reused `manage_commercial_data` key (Admin / Ops Manager) — a non-holder is redirected home; the BFF
 * stays authoritative on the writes. Customer/lane/location options are loaded here under the same guard.
 */
export default async function DocumentRequirementsPage() {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "manage_commercial_data")) redirect("/");

  const t = await getTranslations("Documents.requirementsAdmin");
  const options = await getTripFilterOptions();

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
      </header>
      <RequirementAdmin options={options} />
      <DocumentTypeAdmin />
    </div>
  );
}
