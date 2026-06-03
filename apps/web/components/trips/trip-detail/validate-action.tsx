"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { can, type Role } from "@brazil-tms/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useRecordMilestone, TripsError } from "@/lib/trips/client";
import type { TripDetailView } from "@/lib/trips/trips-read";

/**
 * Trip-Detail validate / reject action (010 + 011, GitHub #11). Surfaces the pre-execution status moves
 * an imported/created trip otherwise has NO control for on Trip Detail (the timeline recorder starts at
 * `at_origin`; the assignment panel renders only for validated/assigned/confirmed):
 *   - `received → validated`        — Validar viagem (010);
 *   - `received → validation_error` — Marcar erro de validação (011), with a REQUIRED reason persisted
 *     on the status-change event via the existing `notes` field (atomic + audited);
 *   - `validation_error → received` — the correction back-step.
 * All go through the EXISTING `POST /api/trips/:id/status` endpoint via `useRecordMilestone` — NO new
 * endpoint/service/permission/table/migration. Gated by the reused `update_trip_status` key (rendered
 * only for a holder AND only on a legal-from status; the BFF re-enforces). pt-BR; reuses the
 * `Trips.detail.error${code}` mapping (the status machine is NOT redefined — edges live in trip-status.ts).
 */
export function ValidateAction({ trip, viewerRole }: { trip: TripDetailView; viewerRole: Role }) {
  const t = useTranslations("Trips.detail");
  const transition = useRecordMilestone(trip.id);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const isReceived = trip.currentStatus === "received";
  const isValidationError = trip.currentStatus === "validation_error";

  // Status-scoped AND permission-scoped (SC-003). The BFF status route re-enforces update_trip_status.
  if ((!isReceived && !isValidationError) || !can(viewerRole, "update_trip_status")) return null;

  const mapError = (e: unknown): string => {
    const code = e instanceof TripsError ? e.code : "REQUEST_FAILED";
    try {
      return t(`error${code}` as never);
    } catch {
      return t("errorREQUEST_FAILED");
    }
  };

  const run = (toStatus: "validated" | "received" | "validation_error", notes?: string) => {
    setError(null);
    transition.mutate(
      // source = operator (audit fidelity); `notes` carries the reject reason, persisted on the event.
      { expectedFromStatus: trip.currentStatus, toStatus, source: "operator_manual", notes },
      { onError: (e) => setError(mapError(e)) },
    );
  };

  const reasonMissing = reason.trim() === "";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("validateSectionTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isReceived ? (
          <>
            <p className="text-sm text-muted-foreground">{t("validateHint")}</p>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("rejectReasonPlaceholder")}
              rows={2}
              maxLength={2000}
              aria-label={t("rejectReasonLabel")}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={() => run("validated")} disabled={transition.isPending}>
                {transition.isPending ? t("validating") : t("validateAction")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => run("validation_error", reason.trim())}
                disabled={transition.isPending || reasonMissing}
                title={reasonMissing ? t("rejectReasonRequired") : undefined}
              >
                {t("rejectAction")}
              </Button>
            </div>
            {reasonMissing ? (
              <p className="text-xs text-muted-foreground">{t("rejectReasonRequired")}</p>
            ) : null}
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{t("revertHint")}</p>
            <Button type="button" onClick={() => run("received")} disabled={transition.isPending}>
              {transition.isPending ? t("validating") : t("revertToReceived")}
            </Button>
          </>
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
