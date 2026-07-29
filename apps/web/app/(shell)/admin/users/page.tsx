import { redirect } from "next/navigation";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { UsersClient } from "@/components/users/users-client";

/**
 * Users & Roles administration (US3). Server guard first: unauthenticated → /login;
 * an authenticated user without `manage_users` → home (FR-011). The BFF stays authoritative.
 */
export default async function AdminUsersPage() {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "manage_users")) redirect("/");

  return <UsersClient />;
}
