"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { formatDateTime } from "@brazil-tms/shared";
import type { TripDetailView } from "@/lib/trips/trips-read";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  TripsError,
  fetchDocumentDownloadUrl,
  useArchiveDocument,
  useDocumentTypes,
  useUploadDocument,
  useVerifyDocument,
} from "@/lib/trips/client";

/**
 * Trip-Detail documents section (008, US1) — replaces the 005 `DocumentsPlaceholder`. Lists the trip's
 * proof documents (+ waivers) with verify/archive/download actions, an upload form (type picker +
 * external reference + notes), and the missing-required-document list against the customer checklist.
 * All writes go through the BFF + invalidate `["trips"]`. pt-BR + error mapping.
 */

const VERIF_CLASS: Record<string, string> = {
  pending_review: "bg-amber-100 text-amber-900",
  accepted: "bg-emerald-100 text-emerald-900",
  rejected: "bg-destructive/15 text-destructive",
};

function Pill({ text, cls }: { text: string; cls: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {text}
    </span>
  );
}

export function DocumentsSection({ trip }: { trip: TripDetailView }) {
  const t = useTranslations("Documents");
  const types = useDocumentTypes();
  const upload = useUploadDocument(trip.id);
  const verify = useVerifyDocument();
  const archive = useArchiveDocument();

  const [documentTypeId, setDocumentTypeId] = useState("");
  const [externalReference, setExternalReference] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeTypes = (types.data?.items ?? []).filter((x) => x.active);

  const mapError = (e: unknown): string => {
    const code = e instanceof TripsError ? e.code : "REQUEST_FAILED";
    try {
      return t(`errors.${code}` as Parameters<typeof t>[0]);
    } catch {
      return code;
    }
  };

  const onUpload = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!file || !documentTypeId) return;
    upload.mutate(
      {
        file,
        meta: {
          documentTypeId,
          externalReference: externalReference.trim() || undefined,
          notes: notes.trim() || undefined,
          fileName: file.name,
        },
      },
      {
        onSuccess: () => {
          setFile(null);
          setExternalReference("");
          setNotes("");
          setDocumentTypeId("");
        },
        onError: (err) => setError(mapError(err)),
      },
    );
  };

  const onVerify = (documentId: string, status: "accepted" | "rejected") => {
    setError(null);
    verify.mutate(
      { documentId, input: { verificationStatus: status } },
      { onError: (err) => setError(mapError(err)) },
    );
  };

  const onArchive = (documentId: string) => {
    setError(null);
    archive.mutate(documentId, { onError: (err) => setError(mapError(err)) });
  };

  const onDownload = async (docId: string) => {
    try {
      const url = await fetchDocumentDownloadUrl(trip.id, docId);
      window.open(url, "_blank", "noopener");
    } catch (err) {
      setError(mapError(err));
    }
  };

  const missing = trip.documentSummary;
  const missingUnique = Array.from(
    new Map(
      [...missing.completionMissing, ...missing.billingMissing].map((m) => [m.documentTypeId, m]),
    ).values(),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Missing-document list against the applicable checklist */}
        <div>
          <h3 className="text-sm font-medium">{t("missingTitle")}</h3>
          {!missing.checklistSignedOff ? (
            <p className="mt-1 text-xs text-amber-700">{t("checklistBlocked")}</p>
          ) : null}
          {missingUnique.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">{t("missingNone")}</p>
          ) : (
            <ul className="mt-1 list-disc pl-5 text-sm">
              {missingUnique.map((m) => (
                <li key={m.documentTypeId}>{m.labelPt}</li>
              ))}
            </ul>
          )}
        </div>

        {/* Existing documents */}
        {trip.documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="space-y-3">
            {trip.documents.map((d) => (
              <li key={d.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{d.documentTypeLabelPt}</span>
                  {d.isWaiver ? (
                    <Pill text={t("waiver")} cls="bg-muted text-muted-foreground" />
                  ) : (
                    <Pill
                      text={t(`status.${d.verificationStatus}` as Parameters<typeof t>[0])}
                      cls={VERIF_CLASS[d.verificationStatus] ?? ""}
                    />
                  )}
                  {d.externalReference ? (
                    <span className="text-muted-foreground">{d.externalReference}</span>
                  ) : null}
                </div>
                {d.isWaiver && d.waivedReason ? (
                  <p className="mt-1 text-muted-foreground">
                    {t("waiverReason")}: {d.waivedReason}
                  </p>
                ) : null}
                {d.notes ? <p className="mt-1">{d.notes}</p> : null}
                <div className="mt-1 text-muted-foreground">
                  {t("uploadedAt")}: {formatDateTime(d.createdAt)}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {d.fileStorageKey ? (
                    <Button size="sm" variant="outline" onClick={() => onDownload(d.id)}>
                      {t("download")}
                    </Button>
                  ) : null}
                  {!d.isWaiver ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onVerify(d.id, "accepted")}
                        disabled={verify.isPending}
                      >
                        {t("accept")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onVerify(d.id, "rejected")}
                        disabled={verify.isPending}
                      >
                        {t("reject")}
                      </Button>
                    </>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onArchive(d.id)}
                    disabled={archive.isPending}
                  >
                    {t("archive")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* Upload form */}
        <form onSubmit={onUpload} className="space-y-3 border-t pt-4">
          <h3 className="text-sm font-medium">{t("uploadTitle")}</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="doc-type">{t("type")}</Label>
              <Select value={documentTypeId || undefined} onValueChange={setDocumentTypeId}>
                <SelectTrigger id="doc-type">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  {activeTypes.map((x) => (
                    <SelectItem key={x.id} value={x.id}>
                      {x.labelPt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="doc-ref">{t("externalReference")}</Label>
              <Input
                id="doc-ref"
                value={externalReference}
                onChange={(e) => setExternalReference(e.target.value)}
                maxLength={200}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="doc-file">{t("file")}</Label>
            <Input
              id="doc-file"
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/png,image/jpeg"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="doc-notes">{t("notes")}</Label>
            <Textarea
              id="doc-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={2000}
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" size="sm" disabled={upload.isPending || !file || !documentTypeId}>
            {upload.isPending ? t("sending") : t("submit")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
