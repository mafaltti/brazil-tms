"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import {
  ASSIGNABLE_ROLES,
  createUserSchema,
  type CreateUserInput,
  type Role,
} from "@brazil-tms/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DialogFooter } from "@/components/ui/dialog";

type OnboardingMethod = "invite" | "temp_password";

// Least-privilege default: a new user is read-only until the admin deliberately elevates them.
// (ASSIGNABLE_ROLES[0] is "admin" — defaulting new users to Admin would be unsafe.)
const DEFAULT_NEW_USER_ROLE: Role = "executive_viewer";

export interface UserFormProps {
  onSubmit: (input: CreateUserInput) => Promise<void> | void;
  onCancel: () => void;
  submitting: boolean;
  errorMessage?: string | null;
}

/**
 * Create-user form (FR-013, FR-013a). The RHF model mirrors `CreateUserInput` exactly, so
 * `zodResolver(createUserSchema)` validates name/email/role and the `onboarding` discriminated
 * union (temp-password length) in one pass.
 */
export function UserForm({ onSubmit, onCancel, submitting, errorMessage }: UserFormProps) {
  const t = useTranslations("AdminUsers");
  const tRoles = useTranslations("Roles");
  const tCommon = useTranslations("Common");

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<CreateUserInput>({
    resolver: zodResolver(createUserSchema),
    defaultValues: {
      name: "",
      email: "",
      role: DEFAULT_NEW_USER_ROLE,
      onboarding: { method: "invite" },
    },
  });

  // The two Selects are driven by local state (guaranteed re-render) and synced into RHF — relying
  // on watch() of a nested path while setValue replaces the parent object can miss re-renders.
  const [role, setRole] = useState<Role>(DEFAULT_NEW_USER_ROLE);
  const [method, setMethod] = useState<OnboardingMethod>("invite");
  const onboardingErrors = errors.onboarding as
    | { tempPassword?: { message?: string } }
    | undefined;

  function changeRole(value: Role): void {
    setRole(value);
    setValue("role", value, { shouldValidate: true });
  }

  function changeMethod(value: OnboardingMethod): void {
    setMethod(value);
    setValue(
      "onboarding",
      value === "temp_password" ? { method: "temp_password", tempPassword: "" } : { method: "invite" },
      { shouldValidate: false },
    );
  }

  return (
    <form onSubmit={handleSubmit((values) => onSubmit(values))} noValidate className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">{t("name")}</Label>
        <Input id="name" autoComplete="name" {...register("name")} />
        {errors.name ? <p className="text-sm text-destructive">{errors.name.message}</p> : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">{t("email")}</Label>
        <Input id="email" type="email" autoComplete="email" {...register("email")} />
        {errors.email ? <p className="text-sm text-destructive">{errors.email.message}</p> : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="role">{t("role")}</Label>
        <Select value={role} onValueChange={(v) => changeRole(v as Role)}>
          <SelectTrigger id="role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ASSIGNABLE_ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {tRoles(r)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {errors.role ? <p className="text-sm text-destructive">{errors.role.message}</p> : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="method">{t("onboarding")}</Label>
        <Select value={method} onValueChange={(v) => changeMethod(v as OnboardingMethod)}>
          <SelectTrigger id="method">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="invite">{t("onboardingInvite")}</SelectItem>
            <SelectItem value="temp_password">{t("onboardingTempPassword")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {method === "temp_password" ? (
        <div className="space-y-2">
          <Label htmlFor="tempPassword">{t("tempPassword")}</Label>
          <Input
            id="tempPassword"
            type="text"
            autoComplete="off"
            {...register("onboarding.tempPassword")}
          />
          {onboardingErrors?.tempPassword ? (
            <p className="text-sm text-destructive">{onboardingErrors.tempPassword.message}</p>
          ) : null}
        </div>
      ) : null}

      {errorMessage ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          {tCommon("cancel")}
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? tCommon("saving") : t("createUser")}
        </Button>
      </DialogFooter>
    </form>
  );
}
