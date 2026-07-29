import { redirect } from "next/navigation";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { UserDetailClient } from "@/components/users/user-detail-client";

/** Single-user detail/edit (US3). Same server guard as the list page (FR-011). */
export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "manage_users")) redirect("/");

  const { id } = await params;
  return <UserDetailClient userId={id} />;
}
