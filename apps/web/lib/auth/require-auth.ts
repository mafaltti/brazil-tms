import "server-only";
import { can, type PermissionKey, type Role } from "@brazil-tms/shared";
import { verifySession } from "./session";
import { isOnboardingIncomplete, type SessionUser, type UserStatus } from "./session-core";

/** Thrown when there is no valid/active session → HTTP 401. */
export class Unauthorized extends Error {
  readonly status = 401;
  constructor(message = "Não autenticado.") {
    super(message);
    this.name = "Unauthorized";
  }
}

/** Thrown when an authenticated user lacks the required permission → HTTP 403. */
export class Forbidden extends Error {
  readonly status = 403;
  constructor(message = "Acesso negado.") {
    super(message);
    this.name = "Forbidden";
  }
}

/**
 * Thrown when a signed-in user has not completed onboarding (must change password, or still
 * pending). They are restricted to the password flow; every other BFF route rejects them → 403.
 */
export class OnboardingRequired extends Error {
  readonly status = 403;
  readonly code = "PASSWORD_CHANGE_REQUIRED";
  constructor(message = "Conclua a definição de senha antes de continuar.") {
    super(message);
    this.name = "OnboardingRequired";
  }
}

export interface AuthContext {
  userId: string;
  role: Role;
  status: UserStatus;
  user: SessionUser;
}

/**
 * The single authentication gate for the BFF. Throws `Unauthorized` (401) if not signed in, and —
 * unless `allowIncompleteOnboarding` is set — `OnboardingRequired` (403) for a user who still must
 * change their password or is pending. Only `/api/auth/change-password` opts out, so incomplete
 * onboarding cannot reach any other protected route (the BFF is the security boundary, not the UI).
 */
export async function requireAuth(
  opts: { allowIncompleteOnboarding?: boolean } = {},
): Promise<AuthContext> {
  const result = await verifySession();
  if (!result.authenticated) throw new Unauthorized();
  const { user } = result;
  if (!opts.allowIncompleteOnboarding && isOnboardingIncomplete(user)) {
    throw new OnboardingRequired();
  }
  return { userId: user.id, role: user.role, status: user.status, user };
}

/** Assert a permission on an already-resolved context. Throws `Forbidden` (403) if denied. */
export function requirePermission(ctx: AuthContext, key: PermissionKey): void {
  if (!can(ctx.role, key)) throw new Forbidden();
}
