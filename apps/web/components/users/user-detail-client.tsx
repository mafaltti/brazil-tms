"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ASSIGNABLE_ROLES, formatDateTime, type Role } from "@brazil-tms/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { UserProfile } from "@/components/users/users-client";

interface ApiError {
  code: string;
  message: string;
}

async function readApiError(res: Response): Promise<ApiError | null> {
  try {
    const body = (await res.json()) as { error?: ApiError };
    return body.error ?? null;
  } catch {
    return null;
  }
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  active: "default",
  pending: "secondary",
  disabled: "destructive",
};

type UpdatePayload = { role?: Role; status?: "active" | "disabled" };

/** Single-user detail + role/status editing (US3). Reuses the same BFF + i18n as the list view. */
export function UserDetailClient({ userId }: { userId: string }) {
  const t = useTranslations("AdminUsers");
  const tRoles = useTranslations("Roles");
  const tStatus = useTranslations("Status");
  const tCommon = useTranslations("Common");
  const queryClient = useQueryClient();

  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const userQuery = useQuery({
    queryKey: ["admin-users"],
    queryFn: async (): Promise<UserProfile[]> => {
      const res = await fetch("/api/admin/users");
      if (!res.ok) throw new Error("load_failed");
      const body = (await res.json()) as { users: UserProfile[] };
      return body.users;
    },
  });

  function messageForCode(code: string | undefined): string {
    switch (code) {
      case "LAST_ADMIN_GUARD":
        return t("lastAdminGuard");
      case "NOT_PENDING":
        return t("notPending");
      default:
        return t("saveError");
    }
  }

  const updateMutation = useMutation({
    mutationFn: async (payload: UpdatePayload): Promise<void> => {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await readApiError(res);
        throw new Error(err?.code ?? "save_failed");
      }
    },
    onSuccess: () => {
      setError(null);
      setFeedback(t("userUpdated"));
      void queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (e: Error) => setError(messageForCode(e.message)),
  });

  const user = (userQuery.data ?? []).find((u) => u.id === userId);

  if (userQuery.isLoading) {
    return <p className="text-muted-foreground">{tCommon("loading")}</p>;
  }
  if (userQuery.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("loadError")}
      </p>
    );
  }
  if (!user) {
    return (
      <div className="space-y-4">
        <p className="text-muted-foreground">{t("empty")}</p>
        <Button asChild variant="outline">
          <Link href="/admin/users">{tCommon("back")}</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">{t("editUser")}</h1>
        <Button asChild variant="outline">
          <Link href="/admin/users">{tCommon("back")}</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{user.name}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <span className="text-muted-foreground">{t("email")}</span>
            <span>{user.email}</span>
            <span className="text-muted-foreground">{t("status")}</span>
            <span>
              <Badge variant={STATUS_VARIANT[user.status] ?? "outline"}>
                {tStatus(user.status as "pending" | "active" | "disabled")}
              </Badge>
            </span>
            <span className="text-muted-foreground">{t("lastLogin")}</span>
            <span>{formatDateTime(user.lastLoginAt)}</span>
            <span className="text-muted-foreground">{t("createdAt")}</span>
            <span>{formatDateTime(user.createdAt)}</span>
          </div>

          <div className="space-y-2">
            <Label htmlFor="detail-role">{t("role")}</Label>
            <Select
              value={user.role}
              onValueChange={(v) => updateMutation.mutate({ role: v as Role })}
              disabled={updateMutation.isPending}
            >
              <SelectTrigger id="detail-role" className="w-64" aria-label={t("changeRole")}>
                <SelectValue>{tRoles(user.role)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {ASSIGNABLE_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {tRoles(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex gap-2">
            {user.status === "disabled" ? (
              <Button
                variant="outline"
                disabled={updateMutation.isPending}
                onClick={() => updateMutation.mutate({ status: "active" })}
              >
                {t("enable")}
              </Button>
            ) : (
              <Button
                variant="outline"
                disabled={updateMutation.isPending}
                onClick={() => updateMutation.mutate({ status: "disabled" })}
              >
                {t("disable")}
              </Button>
            )}
          </div>

          {feedback ? (
            <p role="status" className="text-sm text-muted-foreground">
              {feedback}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
