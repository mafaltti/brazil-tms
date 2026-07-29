"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { formatDateTime } from "@brazil-tms/shared";
import { TripsError, useAcknowledgeAlert, useAlerts } from "@/lib/trips/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * In-app alert surface (007, US4). Lists the active/acknowledged §17 alerts (newest-first) with
 * per-severity counts and an acknowledge action. Mounted on the Control-Tower board + Home Dashboard;
 * polled on the control-tower cadence. In-app only — nothing leaves the app (FR-025). pt-BR.
 */

const SEVERITY_CLASS: Record<string, string> = {
  low: "bg-muted text-muted-foreground",
  medium: "bg-amber-100 text-amber-900",
  high: "bg-destructive/15 text-destructive",
};

export function AlertSurface() {
  const t = useTranslations("Alerts");
  // Show only ACTIVE alerts: acknowledging an alert drops it from the surface (and the count) while
  // the row persists in the DB as `acknowledged` — so it is never re-generated while still true (D3).
  const query = useAlerts({ state: "active" });
  const acknowledge = useAcknowledgeAlert();

  const items = query.data?.items ?? [];
  const counts = query.data?.counts;

  const mapError = (e: unknown): string => {
    const code = e instanceof TripsError ? e.code : "REQUEST_FAILED";
    try {
      return t(`errors.${code}` as Parameters<typeof t>[0]);
    } catch {
      return t("errors.REQUEST_FAILED");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{t("surfaceTitle")}</CardTitle>
        {counts ? <span className="text-sm text-muted-foreground tabular-nums">{counts.total}</span> : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : query.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {t("loadError")}
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="space-y-2">
            {items.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      SEVERITY_CLASS[a.severity] ?? ""
                    }`}
                  >
                    {t(`caseValue.${a.alertCase}` as Parameters<typeof t>[0])}
                  </span>
                  <Link href={`/trips/${a.tripId}`} className="font-medium text-primary hover:underline">
                    {a.externalTripId ?? a.tripId.slice(0, 8)}
                  </Link>
                  {a.customerName ? <span className="text-muted-foreground">· {a.customerName}</span> : null}
                  <span className="text-muted-foreground">{formatDateTime(a.createdAt)}</span>
                </div>
                {a.state === "acknowledged" ? (
                  <span className="text-xs text-muted-foreground">{t("acknowledged")}</span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={acknowledge.isPending}
                    onClick={() =>
                      acknowledge.mutate(a.id, {
                        onError: (e) => {
                          // Surface a transient error inline via the row title attribute.
                          console.error(mapError(e));
                        },
                      })
                    }
                  >
                    {t("acknowledge")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
