"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { DialogFooter } from "@/components/ui/dialog";

/**
 * Reusable form primitives for the master-data screens (feature 002). The seven entity forms differ
 * in their fields (contacts array, cascading customer→location pickers, the ownership/carrier
 * conditional), so instead of one rigid mega-form this exposes the genuinely-shared pieces: a form
 * shell (footer + submit/cancel + pt-BR error surfacing for 400/409) and a labeled `Field` wrapper.
 * Each screen composes these with its own inputs and a `zodResolver(<entity>Schema)` from
 * `@brazil-tms/shared`.
 */

export interface FieldProps {
  label: string;
  htmlFor?: string;
  error?: string;
  required?: boolean;
  hint?: string;
  children: ReactNode;
}

/** Label + control + inline error. */
export function Field({ label, htmlFor, error, required, hint, children }: FieldProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-0.5">
        <Label htmlFor={htmlFor}>{label}</Label>
        {required ? (
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        ) : null}
      </div>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

export interface EntityFormShellProps {
  onSubmit: () => void;
  onCancel: () => void;
  submitting: boolean;
  /** Already-localized error message (mapped from the API error code/issues). */
  errorMessage?: string | null;
  submitLabel?: string;
  children: ReactNode;
}

/** Form wrapper: renders fields, a submit/cancel footer, and a top-level error alert. */
export function EntityFormShell({
  onSubmit,
  onCancel,
  submitting,
  errorMessage,
  submitLabel,
  children,
}: EntityFormShellProps) {
  const tCommon = useTranslations("Common");
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}

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
          {submitting ? tCommon("saving") : (submitLabel ?? tCommon("save"))}
        </Button>
      </DialogFooter>
    </form>
  );
}
