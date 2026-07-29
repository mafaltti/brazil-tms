import { redirect } from "next/navigation";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { CustomersClient } from "@/components/master-data/customers-client";

/** Customers administration (US1). Server guard: no `manage_commercial_data` → home (FR-011/SC-011). */
export default async function CustomersPage() {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "manage_commercial_data")) redirect("/");

  return <CustomersClient canArchive={can(session.user.role, "delete_archive")} />;
}
