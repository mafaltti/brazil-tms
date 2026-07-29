import "server-only";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { db, users } from "@brazil-tms/db";
import type { Role } from "@brazil-tms/shared";
import { createSupabaseServerClient } from "../supabase/server";
import { evaluateProfile, type ProfileRow, type SessionResult } from "./session-core";

async function loadSession(): Promise<SessionResult> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  const authUserId = error || !data.user ? null : data.user.id;
  if (!authUserId) return evaluateProfile(null, null);

  const rows = await db.select().from(users).where(eq(users.id, authUserId)).limit(1);
  const row = rows[0];
  const profile: ProfileRow | null = row
    ? {
        id: row.id,
        name: row.name,
        email: row.email,
        // customer_viewer is non-assignable (FR-007); a stored role is always one of the 7.
        role: row.role as Role,
        status: row.status,
        mustChangePassword: row.mustChangePassword,
        lastLoginAt: row.lastLoginAt,
      }
    : null;

  return evaluateProfile(authUserId, profile);
}

/**
 * Authoritative per-request session, wrapped in React `cache()` so repeated calls within one
 * request hit GoTrue + Postgres only once (research §1). Authentication only — permission
 * assertions live in `require-auth.ts`.
 */
export const verifySession = cache(loadSession);

export * from "./session-core";
