import { redirect } from "next/navigation";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { CustomerDetailClient } from "@/components/master-data/customer-detail-client";

/** Customer create (id="new") / edit (US1). Same guard as the list (FR-011). */
export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "manage_commercial_data")) redirect("/");

  const { id } = await params;
  return (
    <CustomerDetailClient customerId={id} canArchive={can(session.user.role, "delete_archive")} />
  );
}
