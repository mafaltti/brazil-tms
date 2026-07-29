"use client";

import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import type { TripFilterOptions } from "@brazil-tms/db";
import { useTripDetail } from "@/lib/trips/client";
import { canCancelTrip, type CancelScope } from "@/lib/trips/cancel-scope";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CancelTripDialog } from "@/components/trips/cancel-trip-dialog";
import { TripDetailHeader } from "@/components/trips/trip-detail/header";
import { CustomerPlanSection } from "@/components/trips/trip-detail/customer-plan";
import { TimelineSection } from "@/components/trips/trip-detail/timeline";
import { NotesSection } from "@/components/trips/trip-detail/notes";
import { AuditHistorySection } from "@/components/trips/trip-detail/audit-history";
import { DocumentsSection } from "@/components/trips/trip-detail/documents-section";
import { BillingSection } from "@/components/trips/trip-detail/billing-section";
import { ExceptionPanel } from "@/components/trips/trip-detail/exception-panel";
import { SlaIndicator } from "@/components/trips/trip-detail/sla-indicator";
import { AssignmentPanel } from "@/components/trips/trip-detail/assignment-panel";
import { PlanEditForm } from "@/components/trips/plan-edit-form";

/**
 * Trip Detail orchestrator (005 US2/US3). Read-first — freshness is polling via TanStack Query
 * (`useTripDetail`, no Realtime). Composes the section components in the §15.5 order. The plan editor
 * self-guards on `isNonEditableStatus`, so it is always rendered (it shows a read-only message when
 * the trip is closed/terminal). 017: the header row carries the "Cancelar viagem" action
 * (`cancelScope` ∩ machine legality); on success the `["trips"]` invalidation re-renders this page
 * with the terminal state.
 */
export function TripDetailClient({
  id,
  resourceOptions,
  cancelScope = "none",
}: {
  id: string;
  resourceOptions: TripFilterOptions;
  /** 017 — how far this user's cancel permission reaches (§18); computed server-side. */
  cancelScope?: CancelScope;
}) {
  const t = useTranslations("Trips.detail");
  const tCancel = useTranslations("Trips.cancel");
  const tCommon = useTranslations("Common");
  const { data, isLoading, isError } = useTripDetail(id);
  const [cancelOpen, setCancelOpen] = useState(false);

  const backLink = (
    <Button asChild variant="outline">
      <Link href="/trips">{t("back")}</Link>
    </Button>
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <p className="text-muted-foreground">{tCommon("loading")}</p>
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError || !data?.item) {
    return (
      <div className="space-y-4">
        <p role="alert" className="text-sm text-destructive">
          {isError ? t("loadError") : t("notFound")}
        </p>
        {backLink}
      </div>
    );
  }

  const trip = data.item;
  const showCancel = canCancelTrip(cancelScope, trip.currentStatus);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        {backLink}
        {showCancel ? (
          <Button type="button" variant="destructive" onClick={() => setCancelOpen(true)}>
            {tCancel("action")}
          </Button>
        ) : null}
      </div>

      <CancelTripDialog
        tripId={trip.id}
        tripLabel={trip.externalTripId}
        open={cancelOpen}
        onOpenChange={setCancelOpen}
      />

      <TripDetailHeader trip={trip} />
      <CustomerPlanSection trip={trip} />
      <PlanEditForm trip={trip} />
      <AssignmentPanel trip={trip} resourceOptions={resourceOptions} />
      <SlaIndicator trip={trip} />
      <TimelineSection trip={trip} />
      <ExceptionPanel trip={trip} />
      <DocumentsSection trip={trip} />
      <BillingSection trip={trip} />
      <NotesSection events={trip.events} />
      <AuditHistorySection audit={trip.audit} />
    </div>
  );
}
