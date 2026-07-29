"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  ASSIGNABLE_ROLES,
  formatDateTime,
  type CreateUserInput,
  type Role,
} from "@brazil-tms/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UserForm } from "@/components/users/user-form";

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

interface ApiError {
  code: string;
  message: string;
}

/** Read a `{ error: { code, message } }` body; returns null if absent/unparseable. */
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

export function UsersClient() {
  const t = useTranslations("AdminUsers");
  const tRoles = useTranslations("Roles");
  const tStatus = useTranslations("Status");
  const tCommon = useTranslations("Common");
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const usersQuery = useQuery({
    queryKey: ["admin-users"],
    queryFn: async (): Promise<UserProfile[]> => {
      const res = await fetch("/api/admin/users");
      if (!res.ok) throw new Error("load_failed");
      const body = (await res.json()) as { users: UserProfile[] };
      return body.users;
    },
  });

  /** Map a 409 error code to its AdminUsers message; falls back to the generic save error. */
  function messageForCode(code: string | undefined): string {
    switch (code) {
      case "DUPLICATE_EMAIL":
        return t("duplicateEmail");
      case "LAST_ADMIN_GUARD":
        return t("lastAdminGuard");
      case "NOT_PENDING":
        return t("notPending");
      default:
        return t("saveError");
    }
  }

  const createMutation = useMutation({
    mutationFn: async (input: CreateUserInput): Promise<void> => {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const err = await readApiError(res);
        throw new Error(err?.code ?? "save_failed");
      }
    },
    onSuccess: () => {
      setCreateOpen(false);
      setCreateError(null);
      setFeedback(t("userCreated"));
      void queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (error: Error) => {
      setCreateError(messageForCode(error.message));
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (vars: { id: string; payload: UpdatePayload }): Promise<void> => {
      const res = await fetch(`/api/admin/users/${vars.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars.payload),
      });
      if (!res.ok) {
        const err = await readApiError(res);
        throw new Error(err?.code ?? "save_failed");
      }
    },
    onSuccess: () => {
      setRowError(null);
      setFeedback(t("userUpdated"));
      void queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (error: Error) => {
      setRowError(messageForCode(error.message));
    },
  });

  const inviteMutation = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const res = await fetch(`/api/admin/users/${id}/invite`, { method: "POST" });
      if (!res.ok) {
        const err = await readApiError(res);
        throw new Error(err?.code ?? "save_failed");
      }
    },
    onSuccess: () => {
      setRowError(null);
      setFeedback(t("inviteSent"));
      void queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (error: Error) => {
      setRowError(messageForCode(error.message));
    },
  });

  const rows = usersQuery.data ?? [];
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter(
      (u) => u.name.toLowerCase().includes(term) || u.email.toLowerCase().includes(term),
    );
  }, [rows, search]);

  const pending = updateMutation.isPending || inviteMutation.isPending;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="text-muted-foreground">{t("subtitle")}</p>
        </div>
        <Button
          onClick={() => {
            setCreateError(null);
            setCreateOpen(true);
          }}
        >
          {t("newUser")}
        </Button>
      </div>

      <div className="max-w-sm">
        <Input
          type="search"
          placeholder={t("searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={tCommon("search")}
        />
      </div>

      {feedback ? (
        <p role="status" className="text-sm text-muted-foreground">
          {feedback}
        </p>
      ) : null}
      {rowError ? (
        <p role="alert" className="text-sm text-destructive">
          {rowError}
        </p>
      ) : null}

      {usersQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t("loadError")}
        </p>
      ) : null}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("name")}</TableHead>
              <TableHead>{t("email")}</TableHead>
              <TableHead>{t("role")}</TableHead>
              <TableHead>{t("status")}</TableHead>
              <TableHead>{t("lastLogin")}</TableHead>
              <TableHead>{tCommon("actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {usersQuery.isLoading ? (
              <TableRow>
                <TableCell colSpan={6}>{tCommon("loading")}</TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  {t("empty")}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.name}</TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell>
                    <Select
                      value={user.role}
                      onValueChange={(v) =>
                        updateMutation.mutate({ id: user.id, payload: { role: v as Role } })
                      }
                      disabled={pending}
                    >
                      <SelectTrigger className="w-48" aria-label={t("changeRole")}>
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
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[user.status] ?? "outline"}>
                      {tStatus(user.status as "pending" | "active" | "disabled")}
                    </Badge>
                  </TableCell>
                  <TableCell>{formatDateTime(user.lastLoginAt)}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      {user.status === "disabled" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() =>
                            updateMutation.mutate({
                              id: user.id,
                              payload: { status: "active" },
                            })
                          }
                        >
                          {t("enable")}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() =>
                            updateMutation.mutate({
                              id: user.id,
                              payload: { status: "disabled" },
                            })
                          }
                        >
                          {t("disable")}
                        </Button>
                      )}
                      {user.status === "pending" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          onClick={() => inviteMutation.mutate(user.id)}
                        >
                          {t("resendInvite")}
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("createUser")}</DialogTitle>
            <DialogDescription>{t("subtitle")}</DialogDescription>
          </DialogHeader>
          <UserForm
            submitting={createMutation.isPending}
            errorMessage={createError}
            onCancel={() => setCreateOpen(false)}
            onSubmit={(input) => createMutation.mutate(input)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
