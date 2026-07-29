"use client";

import { useTranslations } from "next-intl";
import type { Finding } from "@brazil-tms/shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Renders the server-authoritative eligibility findings (006 US2) for a candidate assignment as a
 * list of severity badges with a pt-BR explanation per `code`. BLOCK = destructive (red), WARN =
 * amber. The UI only DISPLAYS findings — the BFF owns whether an assignment is allowed. The known
 * finding codes are translated under `Dispatch.findingCode`; an unmapped code falls back to a generic
 * label (never a raw code).
 */
export function FindingsList({
  findings,
  loading,
  compact,
}: {
  findings: Finding[];
  loading?: boolean;
  compact?: boolean;
}) {
  const t = useTranslations("Dispatch");

  if (findings.length === 0) {
    if (compact) return null;
    return (
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {loading ? "" : t("findingsNone")}
      </p>
    );
  }

  const codeLabel = (code: string) => {
    const key = `findingCode.${code}` as Parameters<typeof t>[0];
    return t.has(key) ? t(key) : t("findingCode.unknown");
  };

  return (
    <ul className="space-y-1.5" aria-live="polite">
      {findings.map((f, i) => (
        <li key={`${f.check}-${f.resourceId}-${f.code}-${i}`} className="flex items-start gap-2">
          <Badge
            variant={f.severity === "block" ? "destructive" : "outline"}
            className={cn(
              f.severity === "warn" && "border-amber-500 bg-amber-50 text-amber-700",
            )}
          >
            {t(`severity.${f.severity}` as Parameters<typeof t>[0])}
          </Badge>
          <span className="text-sm">
            <span className="font-medium">
              {t(`resourceKind.${f.resourceKind}` as Parameters<typeof t>[0])}
            </span>{" "}
            — {codeLabel(f.code)}
          </span>
        </li>
      ))}
    </ul>
  );
}
