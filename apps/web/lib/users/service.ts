import "server-only";
import { and, desc, eq, ilike, ne, or } from "drizzle-orm";
import { db, users } from "@brazil-tms/db";
import type { CreateUserInput, Role, UpdateUserInput } from "@brazil-tms/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write-audit";
import { Conflict } from "@/lib/api/respond";

/** API response shape for a user profile (timestamps as ISO strings). */
export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: string;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A loaded `public.users` row (Drizzle-inferred shape we care about). */
interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Map a DB row to the API profile shape. `customer_viewer` is never stored (FR-007). */
function toProfile(row: UserRow): UserProfile {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role as Role,
    status: row.status,
    mustChangePassword: row.mustChangePassword,
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Postgres unique-violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

export interface ListUsersOptions {
  search?: string;
  status?: string;
  role?: Role;
}

/** List users, optionally filtered, ordered by creation time (newest first). */
export async function listUsers(opts: ListUsersOptions = {}): Promise<UserProfile[]> {
  const filters = [];
  if (opts.search && opts.search.trim().length > 0) {
    const term = `%${opts.search.trim()}%`;
    filters.push(or(ilike(users.name, term), ilike(users.email, term)));
  }
  if (opts.status) filters.push(eq(users.status, opts.status));
  if (opts.role) filters.push(eq(users.role, opts.role));

  const rows = await db
    .select()
    .from(users)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(users.createdAt));

  return rows.map(toProfile);
}

/**
 * Create a user (FR-013, FR-013a). GoTrue-first: the auth user is provisioned, then the profile
 * row + audit entries are written in one transaction. If the transaction fails the GoTrue user is
 * compensatingly deleted so we never leak an orphaned auth identity.
 */
export async function createUser(
  input: CreateUserInput,
  actorUserId: string,
  redirectTo: string,
): Promise<UserProfile> {
  const { name, email, role, onboarding } = input;

  // Pre-check duplicate email before touching GoTrue (avoids an orphaned auth user).
  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) {
    throw new Conflict("DUPLICATE_EMAIL", "Já existe um usuário com esse e-mail.");
  }

  const admin = createSupabaseAdminClient();
  const invite = onboarding.method === "invite";

  let authUserId: string;
  if (invite) {
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: { name },
    });
    if (error || !data.user) {
      throw new Error(`Falha ao convidar usuário: ${error?.message ?? "sem id"}`);
    }
    authUserId = data.user.id;
  } else {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: onboarding.tempPassword,
      email_confirm: true,
      user_metadata: { name },
      app_metadata: { must_change_password: true },
    });
    if (error || !data.user) {
      throw new Error(`Falha ao criar usuário: ${error?.message ?? "sem id"}`);
    }
    authUserId = data.user.id;
  }

  const status = invite ? "pending" : "active";
  const mustChangePassword = !invite;

  try {
    const profile = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(users)
        .values({ id: authUserId, name, email, role, status, mustChangePassword })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("Inserção de usuário não retornou linha.");

      await writeAudit(tx, {
        entityType: "user",
        entityId: authUserId,
        action: "user.create",
        previousValue: null,
        newValue: { name, email, role, status },
        actorUserId,
      });

      if (invite) {
        await writeAudit(tx, {
          entityType: "user",
          entityId: authUserId,
          action: "user.invite_sent",
          previousValue: null,
          newValue: { email },
          actorUserId,
        });
      }

      return toProfile(row);
    });

    return profile;
  } catch (error) {
    // Compensate: the auth user exists but the profile failed — delete it best-effort.
    try {
      await admin.auth.admin.deleteUser(authUserId);
    } catch (cleanupError) {
      console.error("Failed to compensate orphaned auth user:", authUserId, cleanupError);
    }
    if (isUniqueViolation(error)) {
      throw new Conflict("DUPLICATE_EMAIL", "Já existe um usuário com esse e-mail.");
    }
    throw error;
  }
}

/**
 * Update a user's role and/or status (FR-014, FR-015, FR-016). The last-admin guard runs inside
 * the transaction (FOR UPDATE) so disabling/down-roling the final active admin is rejected before
 * any write. GoTrue ban state is synced best-effort after the commit.
 */
export async function updateUser(
  id: string,
  input: UpdateUserInput,
  actorUserId: string,
): Promise<UserProfile> {
  const currentRows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  const current = currentRows[0];
  if (!current) throw new Conflict("NOT_FOUND", "Usuário não encontrado.");

  const nextRole = input.role ?? (current.role as Role);
  const nextStatus = input.status ?? current.status;

  const roleChanged = input.role !== undefined && input.role !== current.role;
  const statusChanged = input.status !== undefined && input.status !== current.status;

  // Does this change remove the last active admin? (disabling an admin, or moving an admin off admin)
  const removesAdmin =
    current.role === "admin" &&
    current.status === "active" &&
    ((statusChanged && nextStatus === "disabled") || (roleChanged && nextRole !== "admin"));

  const profile = await db.transaction(async (tx) => {
    if (removesAdmin) {
      // Lock the OTHER active-admin rows and count them in code. Postgres rejects FOR UPDATE on an
      // aggregate query, so we must select rows (not count()) here.
      const otherActiveAdmins = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, "admin"), eq(users.status, "active"), ne(users.id, id)))
        .for("update");
      if (otherActiveAdmins.length === 0) {
        throw new Conflict(
          "LAST_ADMIN_GUARD",
          "Não é possível desativar ou rebaixar o último administrador ativo.",
        );
      }
    }

    const updated = await tx
      .update(users)
      .set({ role: nextRole, status: nextStatus, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    const row = updated[0];
    if (!row) throw new Conflict("NOT_FOUND", "Usuário não encontrado.");

    if (roleChanged) {
      await writeAudit(tx, {
        entityType: "user",
        entityId: id,
        action: "user.role_change",
        previousValue: { role: current.role },
        newValue: { role: nextRole },
        actorUserId,
        reason: input.reason ?? null,
      });
    }

    if (statusChanged) {
      await writeAudit(tx, {
        entityType: "user",
        entityId: id,
        action: "user.status_change",
        previousValue: { status: current.status },
        newValue: { status: nextStatus },
        actorUserId,
        reason: input.reason ?? null,
      });
    }

    return toProfile(row);
  });

  // Sync GoTrue ban state (best-effort; the DB status is authoritative for our session check).
  if (statusChanged) {
    try {
      const admin = createSupabaseAdminClient();
      await admin.auth.admin.updateUserById(id, {
        ban_duration: nextStatus === "disabled" ? "876600h" : "none",
      });
    } catch (banError) {
      console.error("Failed to sync GoTrue ban state for user:", id, banError);
    }
  }

  return profile;
}

/** Re-send the invite email for a still-pending user (FR-013). */
export async function resendInvite(
  id: string,
  actorUserId: string,
  redirectTo: string,
): Promise<void> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new Conflict("NOT_FOUND", "Usuário não encontrado.");
  if (row.status !== "pending") {
    throw new Conflict("NOT_PENDING", "O usuário não está pendente.");
  }

  const admin = createSupabaseAdminClient();
  const { error } = await admin.auth.admin.inviteUserByEmail(row.email, {
    redirectTo,
    data: { name: row.name },
  });
  if (error) throw new Error(`Falha ao reenviar convite: ${error.message}`);

  await db.transaction(async (tx) => {
    await writeAudit(tx, {
      entityType: "user",
      entityId: id,
      action: "user.invite_sent",
      previousValue: null,
      newValue: { email: row.email },
      actorUserId,
    });
  });
}

/** Build the invite/reset redirect target from the request origin. */
export function inviteRedirectTo(request: Request): string {
  const origin =
    request.headers.get("origin") ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    new URL(request.url).origin;
  return `${origin}/auth/set-password`;
}
