import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { getTripFilterOptions } from "@/lib/trips/trips-read";
import { ExceptionTable } from "@/components/exceptions/exception-table";

/**
 * Exception Management screen (007, US2, §13). Server guard reuses the pre-declared `view_all_trips`
 * key (held by all seven internal roles) — the queue is a read surface; exception WRITES stay gated on
 * `create_exceptions`/`resolve_exceptions` at the BFF. The filter options (customers/lanes/reason
 * codes/owners) are loaded here under the same guard and passed to the client table. Polling, no Realtime.
 */
export default async function ExceptionsPage() {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "view_all_trips")) redirect("/");

  const t = await getTranslations("Exceptions");
  const options = await getTripFilterOptions();

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </header>
      <ExceptionTable options={options} />
    </div>
  );
}
