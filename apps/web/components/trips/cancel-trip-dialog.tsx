"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { CANCELLATION_RESPONSIBLE_PARTIES, type ResponsibleParty } from "@brazil-tms/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TripsError, useCancellationOptions, useCancelTrip } from "@/lib/trips/client";

/**
 * The ONE cancel-trip dialog (017 R5 — issue #24), shared by its three triggers: the Trip Detail
 * header, a Dispatch board row, and a Control Tower table row. Collects the §19.5 user inputs —
 * motivo + parte responsável + impacto de faturamento, all required (FR-004/FR-006) — from the
 * config-driven option lists (`useCancellationOptions`); the acting user and `cancelled_at` are
 * recorded server-side (FR-005). When a required option kind has no active rows the dialog shows the
 * `notConfigured` empty state instead of an unusable form (FR-011). On success the mutation
 * invalidates the `["trips"]` root, so the caller's surface refreshes itself — the dialog just
 * closes. Controlled by the parent (`open`/`onOpenChange`), one instance per surface fed the row in
 * scope (the quick-assign dialog pattern).
 */
export function CancelTripDialog({
  tripId,
  tripLabel,
  open,
  onOpenChange,
}: {
  tripId: string;
  /** Shown in the title for operator confidence (e.g. the external trip id). */
  tripLabel?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("Trips.cancel");
  const [reasonCode, setReasonCode] = useState("");
  const [responsibleParty, setResponsibleParty] = useState<ResponsibleParty | "">("");
  const [billingImpact, setBillingImpact] = useState("");
  const [showRequired, setShowRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = useCancellationOptions();
  const cancelTrip = useCancelTrip(tripId);

  const reasons = (options.data?.items ?? []).filter((o) => o.kind === "reason");
  const billingImpacts = (options.data?.items ?? []).filter((o) => o.kind === "billing_impact");
  // FR-011 — a kind with zero ACTIVE rows makes cancellation impossible by design (config-driven).
  const notConfigured =
    options.isSuccess && (reasons.length === 0 || billingImpacts.length === 0);

  function reset() {
    setReasonCode("");
    setResponsibleParty("");
    setBillingImpact("");
    setShowRequired(false);
    setError(null);
  }

  function close(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function submit() {
    setError(null);
    if (!reasonCode || !responsibleParty || !billingImpact) {
      setShowRequired(true); // FR-006 — identify the missing element(s) inline
      return;
    }
    cancelTrip.mutate(
      { reasonCode, responsibleParty, billingImpact },
      {
        onSuccess: () => close(false),
        onError: (err) => {
          const code = err instanceof TripsError ? err.code : "REQUEST_FAILED";
          try {
            setError(t(`errors.${code}` as Parameters<typeof t>[0]));
          } catch {
            setError(t("errors.REQUEST_FAILED"));
          }
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("title")}
            {tripLabel ? ` — ${tripLabel}` : ""}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {notConfigured ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {t("notConfigured")}
          </p>
        ) : (
          <div className="space-y-4">
            <CancelSelect
              id="cancel-reason"
              label={t("reasonLabel")}
              placeholder={t("reasonPlaceholder")}
              value={reasonCode}
              onChange={setReasonCode}
              items={reasons.map((r) => ({ value: r.code, label: r.labelPt }))}
              missing={showRequired && !reasonCode}
              missingText={t("requiredField")}
            />
            <CancelSelect
              id="cancel-responsible"
              label={t("responsibleLabel")}
              placeholder={t("responsiblePlaceholder")}
              value={responsibleParty}
              onChange={(v) => setResponsibleParty(v as ResponsibleParty)}
              items={CANCELLATION_RESPONSIBLE_PARTIES.map((p) => ({
                value: p,
                label: t(`responsible.${p}`),
              }))}
              missing={showRequired && !responsibleParty}
              missingText={t("requiredField")}
            />
            <CancelSelect
              id="cancel-billing"
              label={t("billingLabel")}
              placeholder={t("billingPlaceholder")}
              value={billingImpact}
              onChange={setBillingImpact}
              items={billingImpacts.map((b) => ({ value: b.code, label: b.labelPt }))}
              missing={showRequired && !billingImpact}
              missingText={t("requiredField")}
            />
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => close(false)}>
            {t("keep")}
          </Button>
          {notConfigured ? null : (
            <Button
              type="button"
              variant="destructive"
              disabled={cancelTrip.isPending || options.isLoading}
              onClick={submit}
            >
              {cancelTrip.isPending ? t("submitting") : t("confirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A labelled required `Select` over `{value,label}` items, with the inline missing-field error. */
function CancelSelect({
  id,
  label,
  placeholder,
  value,
  onChange,
  items,
  missing,
  missingText,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  items: { value: string; label: string }[];
  missing: boolean;
  missingText: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger id={id} aria-invalid={missing || undefined}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {missing ? (
        <p role="alert" className="text-xs text-destructive">
          {missingText}
        </p>
      ) : null}
    </div>
  );
}
