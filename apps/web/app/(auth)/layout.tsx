import type { ReactNode } from "react";

/**
 * Public auth layout (login, forgot-password, set-password). No session guard — these pages must be
 * reachable while signed out. Just a centered shell.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted p-4">{children}</div>
  );
}
