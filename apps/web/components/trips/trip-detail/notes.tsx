import { useTranslations } from "next-intl";
import { formatDateTime } from "@brazil-tms/shared";
import type { TripDetailView } from "@brazil-tms/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Notes section (005 US2): surfaces the free-text notes captured on trip events (MVP — there is no
 * dedicated notes table yet). Newest-first; empty → `notesEmpty`. Presentational (no `"use client"`).
 */
export function NotesSection({ events }: { events: TripDetailView["events"] }) {
  const t = useTranslations("Trips.detail");

  const withNotes = events
    .filter((ev): ev is typeof ev & { notes: string } => Boolean(ev.notes && ev.notes.trim()))
    .sort((a, b) => {
      const at = a.eventTimestamp ?? a.createdAt;
      const bt = b.eventTimestamp ?? b.createdAt;
      return bt.localeCompare(at);
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("sectionNotes")}</CardTitle>
      </CardHeader>
      <CardContent>
        {withNotes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("notesEmpty")}</p>
        ) : (
          <ul className="space-y-3">
            {withNotes.map((ev) => (
              <li key={ev.id} className="space-y-0.5">
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(ev.eventTimestamp ?? ev.createdAt)}
                </p>
                <p className="text-sm">{ev.notes}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
