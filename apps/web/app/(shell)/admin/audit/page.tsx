import { redirect } from "next/navigation";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { AuditClient } from "@/components/audit/audit-client";

/**
 * Audit read view (US4). Server-side guard: unauthenticated → /login; an authenticated user
 * without `view_audit_log` → / (Admin-only). Nav hiding is additive only; this guard is the
 * authoritative gate (FR-011). The table itself is rendered client-side (TanStack Query polling).
 */
export default async function AuditPage() {
  const s = await verifySession();
  if (!s.authenticated) redirect("/login");
  if (!can(s.user.role, "view_audit_log")) redirect("/");

  return <AuditClient />;
}
