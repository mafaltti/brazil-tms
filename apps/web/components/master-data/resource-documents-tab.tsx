"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  formatDateTime,
  RESOURCE_DOCUMENT_TYPE_SUGGESTIONS,
  type ResourceDocumentDto,
  type ResourceDocumentEntityType,
} from "@brazil-tms/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MasterDataError, readApiError } from "@/lib/master-data/client";

/**
 * Slice 025 (issue #32 [0009]) — the "Documentos" tab shared by the driver and vehicle EDIT pages:
 * an append-only upload history (newest first: date/time São Paulo | type | file name; each entry
 * is a plain `<a target="_blank">` into the 302 download route — the imports error-report
 * pattern) + the upload control (free-text type with per-entity suggestions, PDF/JPG/PNG ≤ ~10 MB).
 * There is deliberately NO delete/replace — history is the requirement.
 */

interface Props {
  entityType: ResourceDocumentEntityType;
  entityId: string;
}

const ENTITY_API: Record<ResourceDocumentEntityType, string> = {
  driver: "drivers",
  vehicle: "vehicles",
};

function documentsPath(entityType: ResourceDocumentEntityType, entityId: string): string {
  return `/api/master-data/${ENTITY_API[entityType]}/${entityId}/documents`;
}

async function fetchDocuments(
  entityType: ResourceDocumentEntityType,
  entityId: string,
): Promise<ResourceDocumentDto[]> {
  const res = await fetch(documentsPath(entityType, entityId));
  if (!res.ok) {
    const err = await readApiError(res);
    throw new MasterDataError(err?.code ?? "REQUEST_FAILED");
  }
  const body = (await res.json()) as { items: ResourceDocumentDto[] };
  return body.items;
}

export function ResourceDocumentsTab({ entityType, entityId }: Props) {
  const t = useTranslations("Resources.documents");
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [docType, setDocType] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const queryKey = ["master-data", ENTITY_API[entityType], "documents", entityId];
  const query = useQuery({
    queryKey,
    queryFn: () => fetchDocuments(entityType, entityId),
    staleTime: 30_000,
  });

  const uploadMutation = useMutation({
    mutationFn: async () => {
      const file = fileRef.current?.files?.[0];
      if (!file) throw new MasterDataError("NO_FILE");
      if (!docType.trim()) throw new MasterDataError("NO_DOC_TYPE");
      const form = new FormData();
      form.set("file", file);
      form.set("meta", JSON.stringify({ docType: docType.trim() }));
      const res = await fetch(documentsPath(entityType, entityId), {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const err = await readApiError(res);
        throw new MasterDataError(err?.code ?? "REQUEST_FAILED");
      }
    },
    onSuccess: () => {
      setError(null);
      setFeedback(t("uploaded"));
      setDocType("");
      if (fileRef.current) fileRef.current.value = "";
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (e: Error) => {
      setFeedback(null);
      const code = e instanceof MasterDataError ? e.code : undefined;
      if (code === "UNSUPPORTED_FILE_TYPE") setError(t("unsupportedType"));
      else if (code === "FILE_TOO_LARGE") setError(t("tooLarge"));
      else if (code === "NO_FILE") setError(t("noFile"));
      else if (code === "NO_DOC_TYPE") setError(t("noDocType"));
      else if (code === "ARCHIVED_RESOURCE") setError(t("archivedResource"));
      else setError(t("uploadError"));
    },
  });

  const items = query.data ?? [];
  const suggestionsId = `${entityType}-doc-type-suggestions`;

  return (
    <div className="space-y-6">
      {/* Upload control — mirrors the reference: type + file + send. */}
      <div className="space-y-3 rounded-md border border-dashed p-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="docType">{t("docType")}</Label>
            <Input
              id="docType"
              list={suggestionsId}
              value={docType}
              maxLength={60}
              placeholder={t("docTypePlaceholder")}
              onChange={(e) => setDocType(e.target.value)}
            />
            <datalist id={suggestionsId}>
              {RESOURCE_DOCUMENT_TYPE_SUGGESTIONS[entityType].map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>
          <div className="space-y-2">
            <Label htmlFor="docFile">{t("file")}</Label>
            <Input id="docFile" ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png" />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            disabled={uploadMutation.isPending}
            onClick={() => uploadMutation.mutate()}
          >
            {uploadMutation.isPending ? t("uploading") : t("upload")}
          </Button>
          <span className="text-xs text-muted-foreground">{t("hint")}</span>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {feedback ? (
          <p role="status" className="text-sm text-muted-foreground">
            {feedback}
          </p>
        ) : null}
      </div>

      {/* Append-only history, newest first. */}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold">{t("historyTitle")}</h2>
        {query.isLoading ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : query.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {t("loadError")}
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {items.map((doc) => (
              <li key={doc.id}>
                {/* Plain link into the 302 download route — user activation survives (no
                    fetch-then-window.open, which popup blockers silently kill). */}
                <a
                  href={`${documentsPath(entityType, entityId)}/${doc.id}/download`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm hover:bg-muted"
                >
                  <span className="tabular-nums text-muted-foreground">
                    {formatDateTime(doc.createdAt)}
                  </span>
                  <span aria-hidden>|</span>
                  <span className="font-medium">{doc.docType}</span>
                  <span className="truncate text-muted-foreground">{doc.fileName}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
