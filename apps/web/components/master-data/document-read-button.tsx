"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  EXTRACTION_MEDIA_TYPES,
  extractionMaxBytes,
  type ExtractionDocType,
  type ExtractionMediaType,
} from "@brazil-tms/shared";
import { Button } from "@/components/ui/button";

/**
 * The shared "Ler documento (IA)" affordance (021, issue #29) used by the driver (CNH) and
 * vehicle/trailer (CRLV) forms. Picks an image (≤ 7.5 MB raw — Anthropic caps images at 10 MB
 * AFTER base64 encoding) or PDF (≤ 10 MB raw), sends it to the extraction endpoint,
 * and hands the extracted fields to the host form to PREFILL — the record is still created only
 * when the user reviews and submits (FR-004). The file is read in-memory and sent once; nothing is
 * persisted (FR-005). Unreadable fields are listed to the user instead of silently skipped
 * (FR-003); a missing provider key degrades to a clear "não configurado" message (FR-007).
 */
export function DocumentReadButton({
  docType,
  fieldLabels,
  onExtracted,
}: {
  docType: ExtractionDocType;
  /** pt-BR label per extractable field key — used in the review/unreadable notices. */
  fieldLabels: Record<string, string>;
  /** Receives ONLY the non-null fields the host form should prefill (via setValue). */
  onExtracted: (fields: Record<string, string>) => void;
}) {
  const t = useTranslations("Resources.aiRead");
  const inputRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ filled: string[]; unreadable: string[] } | null>(null);

  function labelOf(key: string): string {
    return fieldLabels[key] ?? key;
  }

  async function handleFile(file: File) {
    setError(null);
    setNotice(null);
    if (!(EXTRACTION_MEDIA_TYPES as readonly string[]).includes(file.type)) {
      setError(t("invalidType"));
      return;
    }
    // Media-type-aware raw cap (shared with the server's encoded cap) — reject BEFORE any
    // FileReader/fetch work so an oversized pick never leaves the browser.
    if (file.size > extractionMaxBytes(file.type as ExtractionMediaType)) {
      setError(t("tooLarge"));
      return;
    }

    // FileReader → data URL → strip the prefix; the payload lives only in this request.
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

    setReading(true);
    try {
      const res = await fetch("/api/master-data/extract-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docType, mediaType: file.type as ExtractionMediaType, data }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        const code = body?.error?.code;
        if (code === "EXTRACTION_NOT_CONFIGURED") setError(t("notConfigured"));
        else if (code === "FORBIDDEN") setError(t("forbidden"));
        else setError(t("failed"));
        return;
      }
      const { fields, unreadable } = (await res.json()) as {
        fields: Record<string, string | null>;
        unreadable: string[];
      };
      const filled = Object.entries(fields).filter(
        (entry): entry is [string, string] => entry[1] !== null && entry[0] in fieldLabels,
      );
      if (filled.length === 0) {
        setError(t("nothingRead"));
        return;
      }
      onExtracted(Object.fromEntries(filled));
      setNotice({
        filled: filled.map(([key]) => key),
        unreadable: unreadable.filter((key) => key in fieldLabels),
      });
    } catch {
      setError(t("failed"));
    } finally {
      setReading(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={reading}
          onClick={() => inputRef.current?.click()}
        >
          {reading ? t("reading") : t(docType === "cnh" ? "buttonCnh" : "buttonCrlv")}
        </Button>
        <span className="text-xs text-muted-foreground">{t("hint")}</span>
      </div>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept={EXTRACTION_MEDIA_TYPES.join(",")}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // allow re-selecting the same file
          if (file) void handleFile(file);
        }}
      />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("reviewNotice")}
          {notice.unreadable.length > 0
            ? ` ${t("unreadablePrefix")} ${notice.unreadable.map(labelOf).join(", ")}.`
            : ""}
        </p>
      ) : null}
    </div>
  );
}
