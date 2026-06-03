"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { can, type Role } from "@brazil-tms/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useRecordMilestone, TripsError } from "@/lib/trips/client";
import type { TripDetailView } from "@/lib/trips/trips-read";

/**
 * Trip-Detail validate action (010, GitHub #11). Closes the orphaned `received → validated` step: an
 * imported/created trip lands in `received` and otherwise has NO status control on Trip Detail (the
 * timeline's milestone recorder starts at `at_origin`; the assignment panel renders only for
 * validated/assigned/confirmed). This surfaces the deliberate operator promotion `received → validated`
 * (and the `validation_error → received` correction) through the EXISTING `POST /api/trips/:id/status`
 * endpoint via the generic `useRecordMilestone` hook — NO new endpoint/service/permission. Gated by the
 * reused `update_trip_status` key: rendered only for a holder AND only on a status from which the move
 * is legal; the BFF re-enforces the permission regardless of client state. pt-BR; reuses the
 * `Trips.detail.error${code}` mapping (machine NOT redefined — the legal edges live in trip-status.ts).
 */
export function ValidateAction({ trip, viewerRole }: { trip: TripDetailView; viewerRole: Role }) {
  const t = useTranslations("Trips.detail");
  const transition = useRecordMilestone(trip.id);
  const [error, setError] = useState<string | null>(null);

  const isReceived = trip.currentStatus === "received";
  const isValidationError = trip.currentStatus === "validation_error";

  // Status-scoped AND permission-scoped (SC-003). The BFF status route re-enforces update_trip_status.
  if ((!isReceived && !isValidationError) || !can(viewerRole, "update_trip_status")) return null;

  const toStatus = isReceived ? "validated" : "received";
  const actionLabel = isReceived ? t("validateAction") : t("revertToReceived");
  const hint = isReceived ? t("validateHint") : t("revertHint");

  const mapError = (e: unknown): string => {
    const code = e instanceof TripsError ? e.code : "REQUEST_FAILED";
    try {
      return t(`error${code}` as never);
    } catch {
      return t("errorREQUEST_FAILED");
    }
  };

  const onValidate = () => {
    setError(null);
    transition.mutate(
      // Source is the operator (audit fidelity, FR-005) — distinct from the service default `system`.
      { expectedFromStatus: trip.currentStatus, toStatus, source: "operator_manual" },
      { onError: (e) => setError(mapError(e)) },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("validateSectionTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{hint}</p>
        <Button type="button" onClick={onValidate} disabled={transition.isPending}>
          {transition.isPending ? t("validating") : actionLabel}
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
