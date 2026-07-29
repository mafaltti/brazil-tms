import { redirect } from "next/navigation";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { TripImportClient } from "@/components/imports/trip-import-client";

/** Trip Import (004 US1). Server guard: no `import_trips` → home (FR-006). */
export default async function ImportsPage() {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "import_trips")) redirect("/");

  return <TripImportClient />;
}
