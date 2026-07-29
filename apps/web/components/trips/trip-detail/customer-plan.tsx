import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { formatDateTime, VEHICLE_TYPE_VALUES, type VehicleType } from "@brazil-tms/shared";
import type { TripDetailView } from "@brazil-tms/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Customer-plan section (005 US2): three clearly-separated blocks — the immutable `original_plan`
 * snapshot, the live editable `planned_*` fields, and the actual milestone timestamps derived from
 * the trip events. Presentational (isomorphic `useTranslations`, no `"use client"`).
 */

/** Loose view over the immutable `original_plan` jsonb (it is typed `unknown` on the wire). */
type OriginalPlanShape = {
  plannedPickupWindowStart?: string | null;
  plannedPickupWindowEnd?: string | null;
  plannedDeliveryWindowStart?: string | null;
  plannedDeliveryWindowEnd?: string | null;
  plannedVehicleType?: string | null;
  plannedVolumeUnits?: number | null;
  plannedWeightKg?: number | null;
  plannedPalletCount?: number | null;
  plannedRouteNotes?: string | null;
};

/** Event types whose timestamp represents a real-world milestone (for the "actuals" block). */
const ACTUAL_EVENT_TYPES = [
  "origin_arrived",
  "loaded",
  "departed",
  "destination_arrived",
  "unloaded",
  "completed",
] as const;

function FieldRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value ?? "—"}</dd>
    </div>
  );
}

export function CustomerPlanSection({ trip }: { trip: TripDetailView }) {
  const t = useTranslations("Trips.detail");
  const tVehicle = useTranslations("VehicleTypes");

  const original = (trip.originalPlan ?? {}) as OriginalPlanShape;

  // Label a (possibly unknown) vehicle-type string via the `VehicleTypes` namespace (mirrors the
  // board's `vehicleLabel`): known members are translated, anything else is shown raw / em-dash.
  const vehicleLabel = (member: string | null | undefined) => {
    if (!member) return "—";
    return (VEHICLE_TYPE_VALUES as readonly string[]).includes(member)
      ? tVehicle(member as VehicleType)
      : member;
  };

  const window = (start: string | null | undefined, end: string | null | undefined) =>
    `${formatDateTime(start)} – ${formatDateTime(end)}`;

  // Latest timestamp per milestone event type (newest wins) for the actuals block.
  const actuals = new Map<string, string | null>();
  for (const ev of trip.events) {
    if ((ACTUAL_EVENT_TYPES as readonly string[]).includes(ev.eventType)) {
      if (!actuals.has(ev.eventType)) actuals.set(ev.eventType, ev.eventTimestamp);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("sectionCustomerPlan")}</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* (a) Immutable original plan snapshot */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">{t("sectionOriginalPlan")}</h3>
          <dl className="space-y-3">
            <FieldRow
              label={t("fieldPickupWindow")}
              value={window(original.plannedPickupWindowStart, original.plannedPickupWindowEnd)}
            />
            <FieldRow
              label={t("fieldDeliveryWindow")}
              value={window(original.plannedDeliveryWindowStart, original.plannedDeliveryWindowEnd)}
            />
            <FieldRow label={t("fieldVehicleType")} value={vehicleLabel(original.plannedVehicleType)} />
            <FieldRow label={t("fieldVolumeUnits")} value={original.plannedVolumeUnits} />
            <FieldRow label={t("fieldWeightKg")} value={original.plannedWeightKg} />
            <FieldRow label={t("fieldPalletCount")} value={original.plannedPalletCount} />
            <FieldRow label={t("fieldRouteNotes")} value={original.plannedRouteNotes} />
          </dl>
        </section>

        {/* (b) Live (editable) planned fields */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">{t("sectionLivePlan")}</h3>
          <dl className="space-y-3">
            <FieldRow
              label={t("fieldPickupWindow")}
              value={window(trip.plannedPickupWindowStart, trip.plannedPickupWindowEnd)}
            />
            <FieldRow
              label={t("fieldDeliveryWindow")}
              value={window(trip.plannedDeliveryWindowStart, trip.plannedDeliveryWindowEnd)}
            />
            <FieldRow label={t("fieldVehicleType")} value={vehicleLabel(trip.plannedVehicleType)} />
            <FieldRow label={t("fieldVolumeUnits")} value={trip.plannedVolumeUnits} />
            <FieldRow label={t("fieldWeightKg")} value={trip.plannedWeightKg} />
            <FieldRow label={t("fieldPalletCount")} value={trip.plannedPalletCount} />
            <FieldRow label={t("fieldRouteNotes")} value={trip.plannedRouteNotes} />
          </dl>
        </section>

        {/* (c) Actual milestone timestamps derived from events */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">{t("sectionActuals")}</h3>
          {actuals.size === 0 ? (
            <p className="text-sm text-muted-foreground">{t("timelineEmpty")}</p>
          ) : (
            <dl className="space-y-3">
              {ACTUAL_EVENT_TYPES.filter((type) => actuals.has(type)).map((type) => (
                <FieldRow key={type} label={type} value={formatDateTime(actuals.get(type))} />
              ))}
            </dl>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
