import type { Role } from "@brazil-tms/shared";

export type UserStatus = "pending" | "active" | "disabled";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: UserStatus;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
}

/** A loaded `public.users` row, decoupled from Drizzle's inferred type for pure testing. */
export interface ProfileRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: string;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
}

export type SessionResult =
  | { authenticated: true; user: SessionUser }
  | { authenticated: false; reason: "no_session" | "no_profile" | "disabled" };

export function toUserStatus(status: string): UserStatus {
  return status === "active" || status === "disabled" || status === "pending" ? status : "disabled";
}

/**
 * Pure session decision from the GoTrue auth id + the loaded profile. Role/status are read fresh
 * from Postgres each request, so disables and role changes take effect on the next request
 * (SC-007, spec edge cases). A `disabled` profile is rejected immediately.
 */
export function evaluateProfile(
  authUserId: string | null,
  profile: ProfileRow | null,
): SessionResult {
  if (!authUserId) return { authenticated: false, reason: "no_session" };
  if (!profile) return { authenticated: false, reason: "no_profile" };
  const status = toUserStatus(profile.status);
  if (status === "disabled") return { authenticated: false, reason: "disabled" };
  return {
    authenticated: true,
    user: {
      id: profile.id,
      name: profile.name,
      email: profile.email,
      role: profile.role,
      status,
      mustChangePassword: profile.mustChangePassword,
      lastLoginAt: profile.lastLoginAt,
    },
  };
}

/**
 * Onboarding is incomplete while a user must change their password (temp-password path) or is
 * still `pending` (invited, not yet onboarded). Such a user is restricted to the password flow —
 * enforced in BOTH the shell (decideAccess) and the BFF (requireAuth).
 */
export function isOnboardingIncomplete(user: SessionUser): boolean {
  return user.mustChangePassword || user.status === "pending";
}

export type AccessDecision = "allow" | "redirect_login" | "redirect_set_password";

/**
 * Where an authenticated-area request should go. A user who must change their password OR who is
 * still `pending` (invited but not yet onboarded) is restricted to the password flow until they
 * complete it (FR-013a; data-model: "pending cannot use the app except the set-password flow").
 */
export function decideAccess(
  session: SessionResult,
  opts: { isPasswordFlowRoute?: boolean } = {},
): AccessDecision {
  if (!session.authenticated) return "redirect_login";
  if (isOnboardingIncomplete(session.user) && !opts.isPasswordFlowRoute) {
    return "redirect_set_password";
  }
  return "allow";
}
