"use client";

import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * Feature 009 — the shared provisional/blocked banner (R8, clarify Q1). Rendered by the SLA and
 * billing-readiness reports when their read model returns `provisional: true` (a §29 business input is
 * unsupplied, so the figures run on documented defaults). Surfaces the blocked sign-off — never
 * presents provisional figures as final (Constitution II). `reason` is the server-owned pt-BR reason.
 */
export function ProvisionalBanner({ reason }: { reason?: string }) {
  const t = useTranslations("Reports");
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>
        <span className="font-medium">{t("provisionalLabel")}</span>
        {reason ? ` — ${reason}` : null}
      </span>
    </div>
  );
}
