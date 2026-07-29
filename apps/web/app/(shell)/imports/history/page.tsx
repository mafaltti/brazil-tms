import { redirect } from "next/navigation";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { ImportHistoryClient } from "@/components/imports/import-history-client";

/** Import batch history (004 US5). Server guard: no `import_trips` → home (FR-006/INT-004). */
export default async function ImportHistoryPage() {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "import_trips")) redirect("/");

  return <ImportHistoryClient />;
}
