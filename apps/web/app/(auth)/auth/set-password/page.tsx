"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { useTranslations } from "next-intl";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface SetPasswordValues {
  newPassword: string;
  confirmPassword: string;
}

function SetPasswordForm() {
  const t = useTranslations("Auth");
  const router = useRouter();
  const searchParams = useSearchParams();
  const [linkError, setLinkError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<SetPasswordValues>();

  // Invite / recovery deep link: exchange the one-time code for a session before allowing submit.
  useEffect(() => {
    const code = searchParams.get("code");
    if (!code) return;
    let cancelled = false;
    void (async () => {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!cancelled && error) setLinkError(t("linkInvalid"));
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams, t]);

  async function onSubmit(values: SetPasswordValues): Promise<void> {
    setFormError(null);

    if (values.newPassword.length < 8) {
      setFormError(t("passwordTooShort"));
      return;
    }
    if (values.newPassword !== values.confirmPassword) {
      setFormError(t("passwordMismatch"));
      return;
    }

    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: values.newPassword }),
      });

      if (res.ok) {
        setSuccess(true);
        router.push("/");
        router.refresh();
        return;
      }

      setFormError(t("genericError"));
    } catch {
      setFormError(t("genericError"));
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{t("setPasswordTitle")}</CardTitle>
        <CardDescription>{t("setPasswordSubtitle")}</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("setPasswordMustChange")}</p>
          <div className="space-y-2">
            <Label htmlFor="newPassword">{t("newPassword")}</Label>
            <Input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              {...register("newPassword")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirmPassword">{t("confirmPassword")}</Label>
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              {...register("confirmPassword")}
            />
          </div>
          {linkError ? (
            <p role="alert" className="text-sm text-destructive">
              {linkError}
            </p>
          ) : null}
          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}
          {success ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t("setPasswordSuccess")}
            </p>
          ) : null}
        </CardContent>
        <CardFooter>
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {t("setPasswordSubmit")}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

export default function SetPasswordPage() {
  return (
    <Suspense>
      <SetPasswordForm />
    </Suspense>
  );
}
