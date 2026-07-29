import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { TripDetailView } from "@brazil-tms/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TripStatusBadge } from "@/components/trips/trip-status-badge";

/**
 * Trip Detail header (005 US2): identity + at-a-glance status. Presentational — `useTranslations` is
 * isomorphic, so no `"use client"` directive. SLA risk and billing are surfaced as labelled values;
 * the assignment/exceptions/documents detail lives in later-slice placeholder sections.
 */
export function TripDetailHeader({ trip }: { trip: TripDetailView }) {
  const t = useTranslations("Trips.detail");
  const tBilling = useTranslations("Trips.billingStatus");

  const fields: { label: string; value: ReactNode }[] = [
    { label: t("customer"), value: trip.customerName },
    { label: t("externalId"), value: trip.externalTripId ?? "—" },
    { label: t("lane"), value: trip.laneLabel ?? "—" },
    { label: t("status"), value: <TripStatusBadge status={trip.currentStatus} /> },
    { label: t("sla"), value: trip.slaStatus ?? "—" },
    { label: t("billing"), value: tBilling(trip.billingStatus ?? "none") },
    { label: t("importBatch"), value: trip.importBatchId ?? "—" },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {t("trip")} · {trip.externalTripId ?? trip.id}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          {fields.map((f) => (
            <div key={f.label} className="space-y-0.5">
              <dt className="text-xs font-medium text-muted-foreground">{f.label}</dt>
              <dd className="text-sm">{f.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
