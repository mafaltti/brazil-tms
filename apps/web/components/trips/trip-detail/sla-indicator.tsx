"use client";

import { useTranslations } from "next-intl";
import { SLA_STATUSES } from "@brazil-tms/shared";
import type { TripDetailView } from "@/lib/trips/trips-read";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Trip-Detail SLA-risk indicator (007, US3). Renders the SERVER-computed `slaStatus` + `slaReasons`
 * (the UI never computes risk — Constitution III). Status colour reflects severity; the contributing
 * reasons are listed with pt-BR labels. A null status (not yet evaluated / terminal trip) shows "—".
 */

const STATUS_CLASS: Record<string, string> = {
  on_track: "bg-emerald-100 text-emerald-900",
  at_risk: "bg-amber-100 text-amber-900",
  late: "bg-orange-100 text-orange-900",
  breached: "bg-destructive/15 text-destructive",
};

export function SlaIndicator({ trip }: { trip: TripDetailView }) {
  const t = useTranslations("Sla");
  const status = trip.slaStatus;
  const reasons = trip.slaReasons ?? [];

  const known = (s: string | null): s is (typeof SLA_STATUSES)[number] =>
    s != null && (SLA_STATUSES as readonly string[]).includes(s);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("indicatorTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-medium ${
            known(status) ? STATUS_CLASS[status] : "bg-muted text-muted-foreground"
          }`}
        >
          {known(status) ? t(`status.${status}` as Parameters<typeof t>[0]) : t("status.none")}
        </span>

        {reasons.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {reasons.map((r) => (
              <li key={r}>{t(`reason.${r}` as Parameters<typeof t>[0])}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("noReasons")}</p>
        )}
      </CardContent>
    </Card>
  );
}
