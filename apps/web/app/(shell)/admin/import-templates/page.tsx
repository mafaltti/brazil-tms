import { redirect } from "next/navigation";
import { can } from "@brazil-tms/shared";
import { verifySession } from "@/lib/auth/session";
import { ImportTemplatesClient } from "@/components/imports/import-templates-client";

/**
 * Import Template Administration (slice 012, completes CUST-003). Server guard: unauthenticated →
 * /login; missing `import_trips` (= Admin + Operations Manager) → home. Reuses the existing
 * import-template endpoints; no new durable surface.
 */
export default async function ImportTemplatesPage() {
  const session = await verifySession();
  if (!session.authenticated) redirect("/login");
  if (!can(session.user.role, "import_trips")) redirect("/");

  return <ImportTemplatesClient />;
}
