import { z } from "zod";
import { ASSIGNABLE_ROLES, type Role } from "../auth/permissions";

/**
 * Assignable roles as a Zod enum. `customer_viewer` is intentionally absent (FR-007) so any
 * attempt to assign it fails validation before reaching the BFF / `can()`.
 */
export const roleSchema = z.enum(ASSIGNABLE_ROLES as [Role, ...Role[]], {
  errorMap: () => ({ message: "Perfil inválido." }),
});

const nameSchema = z
  .string()
  .trim()
  .min(2, "O nome deve ter no mínimo 2 caracteres.")
  .max(120, "O nome deve ter no máximo 120 caracteres.");

const emailSchema = z.string().trim().min(1, "Informe o e-mail.").email("E-mail inválido.");

/** Onboarding path: invite email OR an admin-set temporary password (FR-013a). */
export const onboardingSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("invite") }),
  z.object({
    method: z.literal("temp_password"),
    tempPassword: z.string().min(8, "A senha temporária deve ter no mínimo 8 caracteres."),
  }),
]);
export type OnboardingInput = z.infer<typeof onboardingSchema>;

/** Create a user (POST /api/admin/users). */
export const createUserSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  role: roleSchema,
  onboarding: onboardingSchema,
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

/** Change a user's role (subject to the last-admin guard in the service). */
export const updateUserRoleSchema = z.object({ role: roleSchema });
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>;

/** Enable/disable a user (admins never set `pending` directly — FR-016 guard in the service). */
export const updateUserStatusSchema = z.object({
  status: z.enum(["active", "disabled"], {
    errorMap: () => ({ message: "Status inválido." }),
  }),
  reason: z.string().trim().max(500, "Motivo muito longo.").optional(),
});
export type UpdateUserStatusInput = z.infer<typeof updateUserStatusSchema>;

/**
 * Combined PATCH body for /api/admin/users/:id — role and/or status (at least one required).
 * The route applies whichever fields are present.
 */
export const updateUserSchema = z
  .object({
    role: roleSchema.optional(),
    status: z.enum(["active", "disabled"]).optional(),
    reason: z.string().trim().max(500, "Motivo muito longo.").optional(),
  })
  .refine((data) => data.role !== undefined || data.status !== undefined, {
    message: "Nada para atualizar.",
  });
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
