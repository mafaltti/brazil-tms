import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { DocumentList } from "@/components/documents/document-list";

/**
 * Documents screen (008, US1, §15.9). Server guard reuses `view_all_trips` (all seven internal roles
 * read). Shows the billing-phase trips still missing required proof, deep-linking to each trip detail
 * where documents are attached/verified. Polling, no Realtime.
 */
export default async function DocumentsPage() {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "view_all_trips")) redirect("/");

  const t = await getTranslations("Documents");

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">{t("screenTitle")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </header>
      <DocumentList />
    </div>
  );
}
