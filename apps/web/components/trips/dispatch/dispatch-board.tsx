"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { formatDateTime } from "@brazil-tms/shared";
import type { TripBoardRow, TripFilterOptions } from "@brazil-tms/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AssignmentForm } from "@/components/trips/dispatch/assignment-form";
import { useTripBoard } from "@/lib/trips/client";

/**
 * The Dispatch Board (006 US5, §15.6): the dispatcher's daily workspace — the unassigned-by-pickup
 * queue with an inline assign action per trip. It reads the SAME extended board the Control Tower
 * uses, pinned to `assigned=false&status=received&sort=pickupStart`, so resource availability and
 * conflict state reflect the latest poll (30s, built into `useTripBoard` — NO Realtime). Assigning
 * uses the SAME shared `AssignmentForm` (one write path, FR-022); the form surfaces server-authoritative
 * findings as the dispatcher picks. Focused queue — availability is the trip's pickup ordering plus the
 * form's live conflict check, not a separate resource-calendar widget (kept minimal per the brief).
 *
 * Slice 015 (FR-006): the queue is narrowed to `status=received` (a non-empty status suppresses the
 * `scope=active` default in `buildWhere`) so it lists ONLY unassigned `received` trips — every "Atribuir"
 * it offers can succeed (`received → assigned`). The validation states were collapsed into `received`,
 * which is now the first dispatchable status (slice 015 superseded slice 014's `status=validated` queue).
 */

const DISPATCH_QUERY = "assigned=false&status=received&sort=pickupStart";

export function DispatchBoard({ resourceOptions }: { resourceOptions: TripFilterOptions }) {
  const t = useTranslations("Dispatch");
  const board = useTripBoard(DISPATCH_QUERY);

  // The trip whose assign dialog is open.
  const [assignRow, setAssignRow] = useState<TripBoardRow | null>(null);

  const items = board.data?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("queueTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        {board.isLoading ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : board.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {t("boardLoadError")}
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("boardEmpty")}</p>
        ) : (
          <ul className="space-y-3">
            {items.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3"
              >
                <div className="space-y-1">
                  <Link
                    href={`/trips/${row.id}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {row.externalTripId ?? t("noExternalId")}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {row.customerName} · {row.originCode || "—"} → {row.destinationCode || "—"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("pickup")}: {formatDateTime(row.plannedPickupWindowStart)}
                  </p>
                </div>
                <Button type="button" size="sm" onClick={() => setAssignRow(row)}>
                  {t("assignAction")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {/* Assign dialog — the shared AssignmentForm for the queued trip (one write path, FR-022). */}
      <Dialog open={assignRow != null} onOpenChange={(open) => !open && setAssignRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("openAssign")}
              {assignRow?.externalTripId ? ` — ${assignRow.externalTripId}` : ""}
            </DialogTitle>
          </DialogHeader>
          {assignRow ? (
            <AssignmentForm
              tripId={assignRow.id}
              currentStatus={assignRow.currentStatus}
              currentAssignment={null}
              resourceOptions={resourceOptions}
              onDone={() => setAssignRow(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
