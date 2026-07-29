"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime, TRANSITIONS, TRIP_STATUSES, type TripStatus } from "@brazil-tms/shared";
import { useAddTripNote, useRecordMilestone, TripsError } from "@/lib/trips/client";
import type { TripDetailView } from "@/lib/trips/trips-read";

/**
 * Interactive execution timeline (007, US1). Upgrades the read-only 005 timeline: a milestone
 * recorder (the next legal statuses, driven through the 003 machine via `useRecordMilestone`), a
 * free-form note entry (`useAddTripNote`), and a chronological event list with planned-vs-actual
 * deltas (planned pickup/delivery windows vs the recorded `eventTimestamp`). SLA is recomputed
 * server-side on every milestone; the UI never computes it. pt-BR labels + error mapping.
 */

/** The execution milestone vocabulary — the statuses a dispatcher advances a trip through (FR-003). */
const MILESTONE_STATUSES = new Set<TripStatus>([
  "at_origin",
  "loading",
  "loaded",
  "in_transit",
  "at_destination",
  "unloading",
  "unloaded",
  "completed",
]);

const MINUTE = 60_000;

export function TimelineSection({ trip }: { trip: TripDetailView }) {
  const t = useTranslations("Trips.detail");
  const tStatus = useTranslations("Trips.status");
  const tEvent = useTranslations("Trips.detail.eventType");
  const recordMilestone = useRecordMilestone(trip.id);
  const addNote = useAddTripNote(trip.id);

  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const events = trip.events;
  const ordered = [...events].sort((a, b) => {
    const at = a.eventTimestamp ?? a.createdAt;
    const bt = b.eventTimestamp ?? b.createdAt;
    return bt.localeCompare(at);
  });

  const statusLabel = (s: string | null) => {
    if (!s) return "—";
    return (TRIP_STATUSES as readonly string[]).includes(s) ? tStatus(s as TripStatus) : s;
  };

  const eventLabel = (type: string) => {
    try {
      return tEvent(type as never);
    } catch {
      return type;
    }
  };

  const mapError = (e: unknown): string => {
    const code = e instanceof TripsError ? e.code : "REQUEST_FAILED";
    try {
      return t(`error${code}` as never);
    } catch {
      return t("errorREQUEST_FAILED");
    }
  };

  // Next legal milestone statuses from the single shared transition table (machine NOT redefined).
  const nextStatuses = (TRANSITIONS[trip.currentStatus] ?? []).filter((s) =>
    MILESTONE_STATUSES.has(s),
  );

  const onRecord = (toStatus: TripStatus) => {
    setError(null);
    recordMilestone.mutate(
      {
        expectedFromStatus: trip.currentStatus,
        toStatus,
        source: "operator_manual",
        eventTimestamp: new Date(),
      },
      { onError: (e) => setError(mapError(e)) },
    );
  };

  const onAddNote = () => {
    if (note.trim() === "") return;
    setError(null);
    addNote.mutate(
      { notes: note.trim() },
      {
        onSuccess: () => setNote(""),
        onError: (e) => setError(mapError(e)),
      },
    );
  };

  /** Planned-vs-actual delta for an arrival milestone (FR-005). Returns a localized label or null. */
  const deltaLabel = (statusAfter: string | null, eventTs: string | null): string | null => {
    if (!eventTs) return null;
    let planned: string | null = null;
    if (statusAfter === "at_origin") planned = trip.plannedPickupWindowEnd;
    else if (statusAfter === "at_destination") planned = trip.plannedDeliveryWindowEnd;
    if (!planned) return null;
    const diffMin = Math.round((new Date(eventTs).getTime() - new Date(planned).getTime()) / MINUTE);
    if (diffMin === 0) return t("deltaOnTime");
    return diffMin > 0
      ? t("deltaLate", { minutes: diffMin })
      : t("deltaEarly", { minutes: -diffMin });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("sectionTimeline")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Milestone recorder — next legal statuses through the 003 machine. */}
        {nextStatuses.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">{t("nextMilestone")}:</span>
            {nextStatuses.map((s) => (
              <Button
                key={s}
                size="sm"
                variant="outline"
                disabled={recordMilestone.isPending}
                onClick={() => onRecord(s)}
              >
                {recordMilestone.isPending ? t("recording") : statusLabel(s)}
              </Button>
            ))}
          </div>
        ) : null}

        {/* Free-form note entry. */}
        <div className="space-y-2">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("notePlaceholder")}
            rows={2}
            maxLength={2000}
          />
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={onAddNote} disabled={addNote.isPending || note.trim() === ""}>
              {addNote.isPending ? t("addingNote") : t("addNote")}
            </Button>
            {error ? <span className="text-sm text-destructive">{error}</span> : null}
          </div>
        </div>

        {/* Chronological event list with planned-vs-actual deltas. */}
        {ordered.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("timelineEmpty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("auditWhen")}</TableHead>
                <TableHead>{t("colEvent")}</TableHead>
                <TableHead>{t("status")}</TableHead>
                <TableHead>{t("colDelta")}</TableHead>
                <TableHead>{t("sectionNotes")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ordered.map((ev) => {
                const delta = deltaLabel(ev.statusAfter, ev.eventTimestamp);
                return (
                  <TableRow key={ev.id}>
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(ev.eventTimestamp ?? ev.createdAt)}
                    </TableCell>
                    <TableCell>{eventLabel(ev.eventType)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {ev.statusBefore || ev.statusAfter
                        ? `${statusLabel(ev.statusBefore)} → ${statusLabel(ev.statusAfter)}`
                        : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {delta ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{ev.notes ?? "—"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
