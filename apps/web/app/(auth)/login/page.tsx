"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { loginSchema, type LoginInput } from "@brazil-tms/shared";
import { ArrowRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoginShell } from "@/components/auth/login-shell";

function LoginForm() {
  const t = useTranslations("Auth");
  const router = useRouter();
  const searchParams = useSearchParams();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  async function onSubmit(values: LoginInput): Promise<void> {
    setFormError(null);
    try {
      const res = await fetch("/api/auth/sign-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      if (res.ok) {
        const json = (await res.json()) as { redirectTo: string };
        const requested = searchParams.get("redirectTo");
        const target = requested && requested.startsWith("/") ? requested : json.redirectTo;
        router.push(target);
        router.refresh();
        return;
      }

      if (res.status === 401) {
        setFormError(t("invalidCredentials"));
      } else if (res.status === 403) {
        setFormError(t("accountDisabled"));
      } else {
        setFormError(t("genericError"));
      }
    } catch {
      setFormError(t("genericError"));
    }
  }

  return (
    <>
      <p className="mt-6 flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B7566] dark:text-muted-foreground">
        <span className="size-2 rounded-full bg-[#D9BA05]" />
        {t("portalEyebrow")}
      </p>
      <h1 className="mt-2.5 text-[25px] font-semibold leading-tight tracking-[-0.02em] text-[#1B2418] dark:text-foreground xl:text-[28px]">
        {t("welcomeTitle")}
      </h1>
      <p className="mt-1.5 text-[14px] leading-relaxed text-[#6B7566] dark:text-muted-foreground">
        {t("welcomeSubtitle")}
      </p>
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="mt-7 space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">{t("email")}</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder={t("emailPlaceholder")}
            className="h-12 rounded-xl"
            {...register("email")}
          />
          {errors.email ? <p className="text-sm text-destructive">{errors.email.message}</p> : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">{t("password")}</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            className="h-12 rounded-xl"
            {...register("password")}
          />
          {errors.password ? (
            <p className="text-sm text-destructive">{errors.password.message}</p>
          ) : null}
        </div>
        {formError ? (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={isSubmitting}
          className="flex h-12 w-full items-center justify-center gap-2.5 rounded-xl bg-[#3E5635] text-[15px] font-semibold text-white shadow-[0_10px_24px_-12px_rgba(62,86,53,0.9)] transition-[filter,opacity] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#33588C] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:shadow-none"
        >
          {isSubmitting ? t("signingIn") : t("signIn")}
          <ArrowRight className="size-[18px]" aria-hidden />
        </button>
        <Link
          href="/forgot-password"
          className="block text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          {t("forgotPasswordLink")}
        </Link>
      </form>
    </>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginShell>
        <LoginForm />
      </LoginShell>
    </Suspense>
  );
}
