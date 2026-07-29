"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import {
  EXCEPTION_RESPONSIBLE_PARTIES,
  EXCEPTION_SEVERITIES,
  formatDateTime,
  type ExceptionSeverity,
  type ExceptionResponsibleParty,
} from "@brazil-tms/shared";
import type { TripDetailView } from "@/lib/trips/trips-read";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
  useCreateException,
  useReasonCodes,
  useTransitionException,
} from "@/lib/trips/client";

/**
 * Trip-Detail exception panel (007, US2) — replaces the 005 `ExceptionsPlaceholder`. Lists the trip's
 * exceptions (status/severity/responsible-party/category, derived from the reason code), a create form
 * (reason-code picker that pre-fills the default severity + responsible party, both overridable, plus
 * a description), and the lifecycle actions Monitor / Resolve / Cancel (Resolve prompts for closure
 * notes). All writes go through the BFF and invalidate the `["trips"]` root. pt-BR + error mapping.
 */

const SEVERITY_CLASS: Record<string, string> = {
  low: "bg-muted text-muted-foreground",
  medium: "bg-amber-100 text-amber-900",
  high: "bg-destructive/15 text-destructive",
};

const STATUS_CLASS: Record<string, string> = {
  open: "bg-amber-100 text-amber-900",
  monitoring: "bg-blue-100 text-blue-900",
  resolved: "bg-emerald-100 text-emerald-900",
  cancelled: "bg-muted text-muted-foreground",
};

function Pill({ text, cls }: { text: string; cls: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {text}
    </span>
  );
}

export function ExceptionPanel({ trip }: { trip: TripDetailView }) {
  const t = useTranslations("Exceptions");
  const reasonCodes = useReasonCodes();
  const createException = useCreateException(trip.id);
  const transitionException = useTransitionException();

  const [reasonCodeId, setReasonCodeId] = useState("");
  const [severity, setSeverity] = useState<ExceptionSeverity | "">("");
  const [responsibleParty, setResponsibleParty] = useState<ExceptionResponsibleParty | "">("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Pending closure notes per exception id (only used for the Resolve action).
  const [closureFor, setClosureFor] = useState<string | null>(null);
  const [closureNotes, setClosureNotes] = useState("");

  const codes = reasonCodes.data?.items ?? [];

  const mapError = (e: unknown): string => {
    const codeErr = e instanceof TripsError ? e.code : "REQUEST_FAILED";
    try {
      return t(`errors.${codeErr}` as Parameters<typeof t>[0]);
    } catch {
      return t("errors.REQUEST_FAILED");
    }
  };

  // Selecting a reason code pre-fills the default severity + responsible party (both overridable).
  const onPickReasonCode = (id: string) => {
    setReasonCodeId(id);
    const code = codes.find((c) => c.id === id);
    if (code) {
      setSeverity(code.defaultSeverity as ExceptionSeverity);
      setResponsibleParty(code.defaultResponsibleParty as ExceptionResponsibleParty);
    }
  };

  const onCreate = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!reasonCodeId) return;
    createException.mutate(
      {
        reasonCodeId,
        severity: severity || undefined,
        responsibleParty: responsibleParty || undefined,
        description: description.trim() || undefined,
      },
      {
        onSuccess: () => {
          setReasonCodeId("");
          setSeverity("");
          setResponsibleParty("");
          setDescription("");
        },
        onError: (err) => setError(mapError(err)),
      },
    );
  };

  const onTransition = (exceptionId: string, from: string, to: "monitoring" | "open" | "cancelled") => {
    setError(null);
    transitionException.mutate(
      { exceptionId, input: { expectedFromStatus: from as never, toStatus: to } },
      { onError: (err) => setError(mapError(err)) },
    );
  };

  const onResolve = (exceptionId: string, from: string) => {
    setError(null);
    if (closureNotes.trim() === "") return;
    transitionException.mutate(
      {
        exceptionId,
        input: { expectedFromStatus: from as never, toStatus: "resolved", closureNotes: closureNotes.trim() },
      },
      {
        onSuccess: () => {
          setClosureFor(null);
          setClosureNotes("");
        },
        onError: (err) => setError(mapError(err)),
      },
    );
  };

  const isTerminal = (status: string) => status === "resolved" || status === "cancelled";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("panelTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Existing exceptions */}
        {trip.exceptions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noExceptions")}</p>
        ) : (
          <ul className="space-y-3">
            {trip.exceptions.map((exc) => (
              <li key={exc.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{exc.reasonLabelPt}</span>
                  <Pill text={t(`statusValue.${exc.status}` as Parameters<typeof t>[0])} cls={STATUS_CLASS[exc.status] ?? ""} />
                  <Pill text={t(`severityValue.${exc.severity}` as Parameters<typeof t>[0])} cls={SEVERITY_CLASS[exc.severity] ?? ""} />
                  <span className="text-muted-foreground">
                    {t(`categoryValue.${exc.category}` as Parameters<typeof t>[0])}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                  <span>
                    {t("responsibleParty")}:{" "}
                    {t(`responsiblePartyValue.${exc.responsibleParty}` as Parameters<typeof t>[0])}
                  </span>
                  <span>
                    {t("openedAt")}: {formatDateTime(exc.openedAt)}
                  </span>
                  {exc.ownerName ? (
                    <span>
                      {t("owner")}: {exc.ownerName}
                    </span>
                  ) : null}
                </div>
                {exc.description ? <p className="mt-1">{exc.description}</p> : null}
                {exc.closureNotes ? (
                  <p className="mt-1 text-muted-foreground">
                    {t("closureNotes")}: {exc.closureNotes}
                  </p>
                ) : null}

                {/* Lifecycle actions (non-terminal only) */}
                {!isTerminal(exc.status) ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {exc.status === "open" ? (
                      <Button size="sm" variant="outline" onClick={() => onTransition(exc.id, exc.status, "monitoring")}>
                        {t("monitor")}
                      </Button>
                    ) : null}
                    {exc.status === "monitoring" ? (
                      <Button size="sm" variant="outline" onClick={() => onTransition(exc.id, exc.status, "open")}>
                        {t("reopen")}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setClosureFor(exc.id);
                        setClosureNotes("");
                      }}
                    >
                      {t("resolve")}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => onTransition(exc.id, exc.status, "cancelled")}>
                      {t("cancelException")}
                    </Button>
                  </div>
                ) : null}

                {/* Closure-notes prompt on Resolve */}
                {closureFor === exc.id ? (
                  <div className="mt-2 space-y-2">
                    <Textarea
                      value={closureNotes}
                      onChange={(e) => setClosureNotes(e.target.value)}
                      placeholder={t("closureNotesPlaceholder")}
                      rows={2}
                      maxLength={2000}
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => onResolve(exc.id, exc.status)}
                        disabled={transitionException.isPending || closureNotes.trim() === ""}
                      >
                        {t("resolve")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setClosureFor(null)}>
                        {t("cancelException")}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {/* Create form */}
        <form onSubmit={onCreate} className="space-y-3 border-t pt-4">
          <h3 className="text-sm font-medium">{t("newException")}</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="exc-reason">{t("reasonCode")}</Label>
              <Select value={reasonCodeId || undefined} onValueChange={onPickReasonCode}>
                <SelectTrigger id="exc-reason">
                  <SelectValue placeholder={t("selectReasonCode")} />
                </SelectTrigger>
                <SelectContent>
                  {codes.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.labelPt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exc-severity">{t("severity")}</Label>
              <Select
                value={severity || undefined}
                onValueChange={(v) => setSeverity(v as ExceptionSeverity)}
                disabled={!reasonCodeId}
              >
                <SelectTrigger id="exc-severity">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  {EXCEPTION_SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(`severityValue.${s}` as Parameters<typeof t>[0])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exc-party">{t("responsibleParty")}</Label>
              <Select
                value={responsibleParty || undefined}
                onValueChange={(v) => setResponsibleParty(v as ExceptionResponsibleParty)}
                disabled={!reasonCodeId}
              >
                <SelectTrigger id="exc-party">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  {EXCEPTION_RESPONSIBLE_PARTIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {t(`responsiblePartyValue.${p}` as Parameters<typeof t>[0])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="exc-desc">{t("description")}</Label>
            <Textarea
              id="exc-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("descriptionPlaceholder")}
              rows={2}
              maxLength={2000}
            />
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <Button type="submit" size="sm" disabled={createException.isPending || !reasonCodeId}>
            {createException.isPending ? t("creating") : t("create")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
