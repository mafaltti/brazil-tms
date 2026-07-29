"use client";

import { useState, type FormEvent } from "react";
import { DateTime } from "luxon";
import { useTranslations } from "next-intl";
import {
  APP_TIME_ZONE,
  isNonEditableStatus,
  VEHICLE_TYPE_VALUES,
  type UpdateTripPlanInput,
} from "@brazil-tms/shared";
import type { TripDetailView } from "@brazil-tms/db";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TripsError, useUpdateTripPlan } from "@/lib/trips/client";

/**
 * Inline operational-field editor (005 US3, TRIP-005). Reuses 003's `updateTripPlan` via the BFF
 * (`useUpdateTripPlan`); the route adds the "before completion" status guard. Self-guards on
 * `isNonEditableStatus` so the form never mounts for a closed/terminal trip. Mirrors the
 * mutation + error-code-mapping structure of `customer-detail-client.tsx`.
 *
 * Timestamps: `<input type="datetime-local">` shows wall-clock time in the business zone
 * (America/Sao_Paulo); we seed from the stored UTC ISO and convert the local value back to UTC ISO on
 * submit. The Zod schema coerces the ISO string to a Date server-side.
 *
 * NOTE: `serviceRequirements` is intentionally OMITTED from the editable set for this MVP — it is a
 * free-form jsonb record (`z.record(z.string(), z.unknown())`) with no structured editor here; a raw
 * JSON textarea would be error-prone. It remains read-only in the customer-plan section.
 */

const EMPTY = "";

/** Stored UTC ISO → `yyyy-MM-ddTHH:mm` in the business zone for `datetime-local`. */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return EMPTY;
  const dt = DateTime.fromISO(iso, { zone: "utc" }).setZone(APP_TIME_ZONE);
  return dt.isValid ? dt.toFormat("yyyy-MM-dd'T'HH:mm") : EMPTY;
}

/** `datetime-local` value (business-zone wall clock) → UTC ISO string, or null when cleared. */
function localInputToIso(value: string): string | null {
  if (!value) return null;
  const dt = DateTime.fromISO(value, { zone: APP_TIME_ZONE });
  return dt.isValid ? (dt.toUTC().toISO() ?? null) : null;
}

const ERROR_CODES = [
  "EDIT_NOT_ALLOWED",
  "REVIEW_REQUIRED",
  "STALE_TRANSITION",
  "INVALID_PLAN_WINDOW",
  "NOT_FOUND",
  "VALIDATION",
] as const;
type KnownErrorCode = (typeof ERROR_CODES)[number];

interface FormState {
  plannedPickupWindowStart: string;
  plannedPickupWindowEnd: string;
  plannedDeliveryWindowStart: string;
  plannedDeliveryWindowEnd: string;
  plannedVehicleType: string;
  plannedVolumeUnits: string;
  plannedWeightKg: string;
  plannedPalletCount: string;
  plannedRouteNotes: string;
}

function initialState(trip: TripDetailView): FormState {
  return {
    plannedPickupWindowStart: isoToLocalInput(trip.plannedPickupWindowStart),
    plannedPickupWindowEnd: isoToLocalInput(trip.plannedPickupWindowEnd),
    plannedDeliveryWindowStart: isoToLocalInput(trip.plannedDeliveryWindowStart),
    plannedDeliveryWindowEnd: isoToLocalInput(trip.plannedDeliveryWindowEnd),
    plannedVehicleType: trip.plannedVehicleType ?? EMPTY,
    plannedVolumeUnits: trip.plannedVolumeUnits?.toString() ?? EMPTY,
    plannedWeightKg: trip.plannedWeightKg?.toString() ?? EMPTY,
    plannedPalletCount: trip.plannedPalletCount?.toString() ?? EMPTY,
    plannedRouteNotes: trip.plannedRouteNotes ?? EMPTY,
  };
}

/** A number field → number | null; non-numeric/empty → null. */
function toCount(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === EMPTY) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function PlanEditForm({ trip }: { trip: TripDetailView }) {
  const t = useTranslations("Trips.edit");
  const tVehicle = useTranslations("VehicleTypes");
  const mutation = useUpdateTripPlan(trip.id);

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(() => initialState(trip));
  const [authorizedReview, setAuthorizedReview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Self-guard: a closed/terminal trip cannot be edited (005 R11) — render a message, no form.
  if (isNonEditableStatus(trip.currentStatus)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t("notEditable")}</p>
        </CardContent>
      </Card>
    );
  }

  function set<K extends keyof FormState>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function mapError(code: string): string {
    const known = (ERROR_CODES as readonly string[]).includes(code)
      ? (code as KnownErrorCode)
      : null;
    switch (known) {
      case "EDIT_NOT_ALLOWED":
        return t("errorEDIT_NOT_ALLOWED");
      case "REVIEW_REQUIRED":
        return t("errorREVIEW_REQUIRED");
      case "STALE_TRANSITION":
        return t("errorSTALE_TRANSITION");
      case "INVALID_PLAN_WINDOW":
        return t("errorINVALID_PLAN_WINDOW");
      case "NOT_FOUND":
        return t("errorNOT_FOUND");
      case "VALIDATION":
        return t("errorVALIDATION");
      default:
        return t("errorREQUEST_FAILED");
    }
  }

  function openForm() {
    setForm(initialState(trip));
    setAuthorizedReview(false);
    setError(null);
    setFeedback(null);
    setOpen(true);
  }

  function closeForm() {
    setOpen(false);
    setError(null);
  }

  /** Only include fields the user changed relative to the seeded state. */
  function buildPayload(): UpdateTripPlanInput {
    const seed = initialState(trip);
    const payload: Record<string, unknown> = {};

    const windowKeys = [
      "plannedPickupWindowStart",
      "plannedPickupWindowEnd",
      "plannedDeliveryWindowStart",
      "plannedDeliveryWindowEnd",
    ] as const;
    for (const key of windowKeys) {
      if (form[key] !== seed[key]) payload[key] = localInputToIso(form[key]);
    }

    if (form.plannedVehicleType !== seed.plannedVehicleType) {
      payload.plannedVehicleType = form.plannedVehicleType === EMPTY ? null : form.plannedVehicleType;
    }

    const countKeys = ["plannedVolumeUnits", "plannedWeightKg", "plannedPalletCount"] as const;
    for (const key of countKeys) {
      if (form[key] !== seed[key]) payload[key] = toCount(form[key]);
    }

    if (form.plannedRouteNotes !== seed.plannedRouteNotes) {
      payload.plannedRouteNotes =
        form.plannedRouteNotes.trim() === EMPTY ? null : form.plannedRouteNotes;
    }

    if (authorizedReview) payload.authorizedReview = true;

    return payload as UpdateTripPlanInput;
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFeedback(null);
    const payload = buildPayload();
    mutation.mutate(payload, {
      onSuccess: () => {
        setFeedback(t("success"));
        setOpen(false);
      },
      onError: (err: Error) =>
        setError(mapError(err instanceof TripsError ? err.code : "REQUEST_FAILED")),
    });
  }

  if (!open) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {feedback ? (
            <p role="status" className="text-sm text-muted-foreground">
              {feedback}
            </p>
          ) : null}
          <Button onClick={openForm}>{t("edit")}</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="plannedPickupWindowStart">{t("pickupStart")}</Label>
              <Input
                id="plannedPickupWindowStart"
                type="datetime-local"
                value={form.plannedPickupWindowStart}
                onChange={(e) => set("plannedPickupWindowStart", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plannedPickupWindowEnd">{t("pickupEnd")}</Label>
              <Input
                id="plannedPickupWindowEnd"
                type="datetime-local"
                value={form.plannedPickupWindowEnd}
                onChange={(e) => set("plannedPickupWindowEnd", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plannedDeliveryWindowStart">{t("deliveryStart")}</Label>
              <Input
                id="plannedDeliveryWindowStart"
                type="datetime-local"
                value={form.plannedDeliveryWindowStart}
                onChange={(e) => set("plannedDeliveryWindowStart", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plannedDeliveryWindowEnd">{t("deliveryEnd")}</Label>
              <Input
                id="plannedDeliveryWindowEnd"
                type="datetime-local"
                value={form.plannedDeliveryWindowEnd}
                onChange={(e) => set("plannedDeliveryWindowEnd", e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="plannedVehicleType">{t("vehicleType")}</Label>
              <Select
                value={form.plannedVehicleType || undefined}
                onValueChange={(v) => set("plannedVehicleType", v)}
              >
                <SelectTrigger id="plannedVehicleType">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VEHICLE_TYPE_VALUES.map((member) => (
                    <SelectItem key={member} value={member}>
                      {tVehicle(member)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plannedVolumeUnits">{t("volumeUnits")}</Label>
              <Input
                id="plannedVolumeUnits"
                type="number"
                inputMode="numeric"
                value={form.plannedVolumeUnits}
                onChange={(e) => set("plannedVolumeUnits", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plannedWeightKg">{t("weightKg")}</Label>
              <Input
                id="plannedWeightKg"
                type="number"
                inputMode="numeric"
                value={form.plannedWeightKg}
                onChange={(e) => set("plannedWeightKg", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plannedPalletCount">{t("palletCount")}</Label>
              <Input
                id="plannedPalletCount"
                type="number"
                inputMode="numeric"
                value={form.plannedPalletCount}
                onChange={(e) => set("plannedPalletCount", e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="plannedRouteNotes">{t("routeNotes")}</Label>
            <textarea
              id="plannedRouteNotes"
              rows={3}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              value={form.plannedRouteNotes}
              onChange={(e) => set("plannedRouteNotes", e.target.value)}
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={authorizedReview}
              onChange={(e) => setAuthorizedReview(e.target.checked)}
              className="h-4 w-4 rounded border-input"
            />
            {t("authorizedReview")}
          </label>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <div className="flex gap-2">
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? t("saving") : t("save")}
            </Button>
            <Button type="button" variant="outline" onClick={closeForm} disabled={mutation.isPending}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
