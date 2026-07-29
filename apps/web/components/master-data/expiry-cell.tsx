"use client";

import { useTranslations } from "next-intl";
import { formatDate, type DocumentExpiryState } from "@brazil-tms/shared";
import { Badge } from "@/components/ui/badge";

/**
 * The shared expiry cell for the resource lists (020, issue #27) — drivers (CNH validity) and
 * vehicles/trailers (document validity). Four states over the SERVER-derived
 * `documentExpiryState` (30-day São Paulo-calendar window — the same computation that feeds
 * assignment eligibility; the UI must NEVER re-derive it):
 *
 * - no date        → "Não informada" (muted) — distinct from a healthy registered date (FR-003)
 * - ok             → the formatted date, plain (FR-001)
 * - expiring       → date + outline "A vencer" warning (FR-002)
 * - expired        → date in red + destructive "Vencido" (FR-002)
 */
export function ExpiryCell({
  date,
  state,
}: {
  date: string | null;
  state: DocumentExpiryState;
}) {
  const t = useTranslations("ExpiryState");
  if (!date) {
    return <span className="text-muted-foreground">{t("notInformed")}</span>;
  }
  if (state === "ok") {
    return <span>{formatDate(date)}</span>;
  }
  return (
    <span className="inline-flex items-center gap-2">
      <span className={state === "expired" ? "font-medium text-destructive" : undefined}>
        {formatDate(date)}
      </span>
      <Badge variant={state === "expired" ? "destructive" : "outline"}>{t(state)}</Badge>
    </span>
  );
}
