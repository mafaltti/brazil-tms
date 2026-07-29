import { z } from "zod";

/** Sign-in credentials (BFF + login form). pt-BR messages inline (research §12 — single locale). */
export const loginSchema = z.object({
  email: z.string().min(1, "Informe seu e-mail.").email("E-mail inválido."),
  password: z.string().min(1, "Informe sua senha."),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** Forgot-password request (always answered neutrally regardless of account existence — FR-004). */
export const forgotPasswordSchema = z.object({
  email: z.string().min(1, "Informe seu e-mail.").email("E-mail inválido."),
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

/** New password for the set-password / forced-change flow (FR-013a). */
export const changePasswordSchema = z.object({
  newPassword: z.string().min(8, "A senha deve ter no mínimo 8 caracteres."),
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
