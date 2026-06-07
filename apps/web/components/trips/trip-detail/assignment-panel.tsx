"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { formatDateTime } from "@brazil-tms/shared";
import type { TripAssignmentDto, TripDetailView, TripFilterOptions } from "@brazil-tms/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AssignmentForm } from "@/components/trips/dispatch/assignment-form";

/**
 * Trip-Detail assignment panel (006 US1/US3/US4) — fills slice 005's `AssignmentPlaceholder`. Shows
 * the current assignment (resource names + notes + override reason + assigned/confirmed by/at), the
 * retained supersession history chain (newest-first), and embeds the shared `AssignmentForm` for
 * assign/reassign/confirm/unassign. The form only renders when the trip is in an assignable status
 * (`received`/`assigned`/`confirmed`; slice 015 retargeted off the removed `validated` state); other
 * statuses show the read-only history only. Read-first freshness is the parent `useTripDetail` poll
 * (no Realtime); all text is pt-BR.
 */

const ASSIGNABLE_STATUSES = new Set(["received", "assigned", "confirmed"]);

export function AssignmentPanel({
  trip,
  resourceOptions,
}: {
  trip: TripDetailView;
  resourceOptions: TripFilterOptions;
}) {
  const t = useTranslations("Dispatch");

  const current = trip.currentAssignment;
  const history = trip.assignmentHistory;
  const canAssign = ASSIGNABLE_STATUSES.has(trip.currentStatus);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("panelTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Current assignment ------------------------------------------------------------ */}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t("currentAssignment")}</h3>
          {current ? (
            <CurrentAssignment assignment={current} />
          ) : (
            <p className="text-sm text-muted-foreground">{t("noCurrentAssignment")}</p>
          )}
        </section>

        {/* Assign / reassign / confirm / unassign form ----------------------------------- */}
        {canAssign ? (
          <section className="space-y-2">
            <AssignmentForm
              tripId={trip.id}
              currentStatus={trip.currentStatus}
              currentAssignment={current}
              resourceOptions={resourceOptions}
            />
          </section>
        ) : null}

        {/* Retained history chain (newest-first) ----------------------------------------- */}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t("history")}</h3>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noHistory")}</p>
          ) : (
            <ul className="space-y-3">
              {history.map((a) => (
                <li key={a.id} className="rounded-md border p-3">
                  <AssignmentSummary assignment={a} showSuperseded />
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

/** The current assignment block (resource names + notes + override + by/at metadata). */
function CurrentAssignment({ assignment }: { assignment: TripAssignmentDto }) {
  return (
    <div className="rounded-md border p-3">
      <AssignmentSummary assignment={assignment} />
    </div>
  );
}

/** A single assignment's fields, shared by the current block and each history row. */
function AssignmentSummary({
  assignment,
  showSuperseded,
}: {
  assignment: TripAssignmentDto;
  showSuperseded?: boolean;
}) {
  const t = useTranslations("Dispatch");

  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
      <Field label={t("driver")} value={assignment.driverName} />
      <Field label={t("vehicle")} value={assignment.vehiclePlate} />
      <Field label={t("trailer")} value={assignment.trailerLabel} />
      <Field label={t("carrier")} value={assignment.carrierName} />
      {assignment.notes ? <Field label={t("notes")} value={assignment.notes} /> : null}
      {assignment.overrideReason ? (
        <Field label={t("overrideReason")} value={assignment.overrideReason} />
      ) : null}
      <Field label={t("assignedBy")} value={assignment.assignedByUserId} />
      <Field label={t("assignedAt")} value={formatDateTime(assignment.assignedAt)} />
      {assignment.confirmedAt ? (
        <>
          <Field label={t("confirmedBy")} value={assignment.confirmedByUserId} />
          <Field label={t("confirmedAt")} value={formatDateTime(assignment.confirmedAt)} />
        </>
      ) : null}
      {showSuperseded && assignment.supersededAt ? (
        <Field label={t("supersededAt")} value={formatDateTime(assignment.supersededAt)} />
      ) : null}
    </dl>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value ?? "—"}</dd>
    </div>
  );
}
