"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { BILLING_ADJUSTMENT_TYPES } from "@brazil-tms/shared";
import type { TripDetailView } from "@/lib/trips/trips-read";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  TripsError,
  useAddBillingAdjustment,
  useMarkBillingReady,
  useMarkCompleted,
  useRemoveBillingAdjustment,
  useUpdateBillingItem,
  type WaivedRequirementInput,
} from "@/lib/trips/client";

/**
 * Trip-Detail billing section (008, US2 + US4) — replaces the 005 `BillingPlaceholder`. Shows the
 * computed planned/executed/adjustment/final values, the editable manual base + typed adjustments
 * (US4), the Mark Completed / Mark Billing Ready actions with a server-side blockers display, and a
 * per-document waiver input. All writes go through the BFF + invalidate `["trips"]`. pt-BR.
 */

function brl(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

/** Parse a reais string ("1.500,00" or "1500.00") to integer centavos, or null. */
function reaisToCents(input: string): number | null {
  const normalized = input.replace(/\./g, "").replace(",", ".").trim();
  if (normalized === "") return null;
  const v = Number(normalized);
  return Number.isFinite(v) ? Math.round(v * 100) : null;
}

export function BillingSection({ trip }: { trip: TripDetailView }) {
  const t = useTranslations("Billing");
  const complete = useMarkCompleted(trip.id);
  const billingReady = useMarkBillingReady(trip.id);
  const updateItem = useUpdateBillingItem(trip.id);
  const addAdjustment = useAddBillingAdjustment(trip.id);
  const removeAdjustment = useRemoveBillingAdjustment();

  const [waivers, setWaivers] = useState<WaivedRequirementInput[]>([]);
  const [waiveType, setWaiveType] = useState("");
  const [waiveReason, setWaiveReason] = useState("");
  const [blockers, setBlockers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [manualBase, setManualBase] = useState("");
  const [adjType, setAdjType] = useState("");
  const [adjAmount, setAdjAmount] = useState("");
  const [adjNote, setAdjNote] = useState("");

  const billing = trip.billing;

  const onSaveBase = () => {
    const cents = reaisToCents(manualBase);
    if (cents == null) return;
    updateItem.mutate({ baseFreightCents: cents }, { onSuccess: () => setManualBase("") });
  };

  const onAddAdjustment = () => {
    const cents = reaisToCents(adjAmount);
    if (!adjType || cents == null) return;
    addAdjustment.mutate(
      { type: adjType as (typeof BILLING_ADJUSTMENT_TYPES)[number], amountCents: cents, note: adjNote.trim() || undefined },
      {
        onSuccess: () => {
          setAdjType("");
          setAdjAmount("");
          setAdjNote("");
        },
      },
    );
  };
  // Required docs still missing (union, unique) — candidates for a waiver.
  const missing = Array.from(
    new Map(
      [...trip.documentSummary.completionMissing, ...trip.documentSummary.billingMissing].map((m) => [
        m.documentTypeId,
        m,
      ]),
    ).values(),
  ).filter((m) => !waivers.some((w) => w.documentTypeId === m.documentTypeId));

  const onError = (e: unknown, blockedCode: string) => {
    if (e instanceof TripsError) {
      const f = e.findings as unknown as { blockers?: string[] } | undefined;
      setBlockers(f?.blockers ?? []);
      setError(e.code === blockedCode ? null : e.code);
    } else {
      setError("REQUEST_FAILED");
    }
  };

  const addWaiver = () => {
    if (!waiveType || waiveReason.trim() === "") return;
    setWaivers((prev) => [...prev, { documentTypeId: waiveType, reason: waiveReason.trim() }]);
    setWaiveType("");
    setWaiveReason("");
  };

  const onComplete = () => {
    setBlockers([]);
    setError(null);
    complete.mutate(
      { waivedRequirements: waivers.length ? waivers : undefined },
      { onSuccess: () => setWaivers([]), onError: (e) => onError(e, "COMPLETION_BLOCKED") },
    );
  };

  const onBillingReady = () => {
    setBlockers([]);
    setError(null);
    billingReady.mutate(
      { waivedRequirements: waivers.length ? waivers : undefined },
      { onSuccess: () => setWaivers([]), onError: (e) => onError(e, "BILLING_READY_BLOCKED") },
    );
  };

  const labelFor = (typeId: string) =>
    [...trip.documentSummary.completionMissing, ...trip.documentSummary.billingMissing].find(
      (m) => m.documentTypeId === typeId,
    )?.labelPt ?? typeId;

  const canComplete = trip.currentStatus === "unloaded";
  const canBillingReady = trip.currentStatus === "billing_pending";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Computed values */}
        {billing ? (
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <div className="text-muted-foreground">{t("values.planned")}</div>
              <div className="font-medium">{brl(billing.plannedCents)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">{t("values.executed")}</div>
              <div className="font-medium">{brl(billing.executedCents)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">{t("values.adjustment")}</div>
              <div className="font-medium">{brl(billing.adjustmentCents)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">{t("values.final")}</div>
              <div className="font-medium">{brl(billing.finalBillableCents)}</div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("lists.empty")}</p>
        )}

        {billing && !billing.hasRate ? (
          <p className="text-xs text-amber-700">{t("rateBlocked")}</p>
        ) : null}

        {/* US4 — editable manual base + typed adjustments (BFF gates on edit_rates) */}
        {billing ? (
          <div className="space-y-4 rounded-md border p-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="bill-base">{t("manualAmount")}</Label>
                <Input
                  id="bill-base"
                  inputMode="decimal"
                  placeholder={billing.baseFreightCents != null ? brl(billing.baseFreightCents) : "0,00"}
                  value={manualBase}
                  onChange={(e) => setManualBase(e.target.value)}
                  className="w-40"
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={onSaveBase}
                disabled={updateItem.isPending || reaisToCents(manualBase) == null}
              >
                {t("save")}
              </Button>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium">{t("adjustments.title")}</div>
              {billing.adjustments.length > 0 ? (
                <ul className="space-y-1">
                  {billing.adjustments.map((a) => (
                    <li key={a.id} className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">
                        {(() => {
                          try {
                            return t(`adjustments.types.${a.type}` as Parameters<typeof t>[0]);
                          } catch {
                            return a.type;
                          }
                        })()}
                      </span>
                      <span className="font-medium">{brl(a.amountCents)}</span>
                      {a.note ? <span className="text-muted-foreground">— {a.note}</span> : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto"
                        onClick={() => removeAdjustment.mutate(a.id)}
                        disabled={removeAdjustment.isPending}
                      >
                        {t("adjustments.remove")}
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="adj-type">{t("adjustments.type")}</Label>
                  <Select value={adjType || undefined} onValueChange={setAdjType}>
                    <SelectTrigger id="adj-type" className="w-44">
                      <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent>
                      {BILLING_ADJUSTMENT_TYPES.map((ty) => (
                        <SelectItem key={ty} value={ty}>
                          {(() => {
                            try {
                              return t(`adjustments.types.${ty}` as Parameters<typeof t>[0]);
                            } catch {
                              return ty;
                            }
                          })()}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="adj-amount">{t("adjustments.amount")}</Label>
                  <Input
                    id="adj-amount"
                    inputMode="decimal"
                    value={adjAmount}
                    onChange={(e) => setAdjAmount(e.target.value)}
                    className="w-32"
                  />
                </div>
                <div className="space-y-1.5 flex-1 min-w-[10rem]">
                  <Label htmlFor="adj-note">{t("adjustments.note")}</Label>
                  <Input id="adj-note" value={adjNote} onChange={(e) => setAdjNote(e.target.value)} maxLength={500} />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onAddAdjustment}
                  disabled={addAdjustment.isPending || !adjType || reaisToCents(adjAmount) == null}
                >
                  {t("adjustments.add")}
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {/* Blockers from the last refused gate */}
        {blockers.length > 0 ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
            <div className="font-medium text-amber-900">{t("blockers.title")}</div>
            <ul className="mt-1 list-disc pl-5 text-amber-900">
              {blockers.map((b) => (
                <li key={b}>
                  {(() => {
                    try {
                      return t(`blockers.${b}` as Parameters<typeof t>[0]);
                    } catch {
                      return b;
                    }
                  })()}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Pending waivers */}
        {waivers.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {waivers.map((w) => (
              <span
                key={w.documentTypeId}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
              >
                {labelFor(w.documentTypeId)}
                <button
                  type="button"
                  className="text-muted-foreground"
                  onClick={() =>
                    setWaivers((prev) => prev.filter((x) => x.documentTypeId !== w.documentTypeId))
                  }
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {/* Waiver input (for a missing required document) */}
        {missing.length > 0 ? (
          <div className="space-y-2 rounded-md border p-3">
            <div className="text-sm font-medium">{t("waiver.title")}</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="waive-type">{t("waiver.type")}</Label>
                <Select value={waiveType || undefined} onValueChange={setWaiveType}>
                  <SelectTrigger id="waive-type">
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    {missing.map((m) => (
                      <SelectItem key={m.documentTypeId} value={m.documentTypeId}>
                        {m.labelPt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="waive-reason">{t("waiver.reason")}</Label>
                <Input
                  id="waive-reason"
                  value={waiveReason}
                  onChange={(e) => setWaiveReason(e.target.value)}
                  maxLength={2000}
                />
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={addWaiver} disabled={!waiveType || !waiveReason.trim()}>
              {t("waiver.add")}
            </Button>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          {canComplete ? (
            <Button size="sm" onClick={onComplete} disabled={complete.isPending}>
              {t("markCompleted")}
            </Button>
          ) : null}
          {canBillingReady ? (
            <Button size="sm" onClick={onBillingReady} disabled={billingReady.isPending}>
              {t("markBillingReady")}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
