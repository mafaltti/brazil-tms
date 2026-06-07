"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import type { Finding, TripStatus } from "@brazil-tms/shared";
import type { TripAssignmentDto, TripFilterOptions } from "@brazil-tms/db";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  TripsError,
  useAssignTrip,
  useAssignmentCheck,
  useConfirmAssignment,
  useReassignTrip,
  useUnassignTrip,
} from "@/lib/trips/client";
import { FindingsList } from "@/components/trips/dispatch/findings-list";

/**
 * The single shared assignment form (006, T062) used by THREE entry points (FR-022, one write path):
 * the Trip-Detail `AssignmentPanel`, the Dispatch Board, and the Control-Tower quick-assign dialog.
 *
 * It picks driver/vehicle/trailer/carrier from the server-loaded `resourceOptions` (NOT the
 * `manage_fleet_data`-gated master-data APIs), shows LIVE server-authoritative findings via the
 * dry-run `useAssignmentCheck` endpoint (debounced as resources change), and routes the primary save
 * to assign (status `received`; slice 015, was `validated`) or reassign (`assigned`/`confirmed`).
 * Confirm + Unassign are offered
 * on an `assigned` trip. Conflict authority is server-side: the form disables save on a BLOCK and
 * requires a non-empty override reason whenever a WARN is present (T045) — but the BFF re-enforces
 * both regardless of client state. All text is pt-BR.
 */

const NONE = "__none__";
const CHECK_DEBOUNCE_MS = 400;

/** Map a `TripsError.code` to a `Dispatch.errors.*` key (falls back to REQUEST_FAILED). */
const ERROR_CODES = [
  "INCOMPLETE_ASSIGNMENT",
  "OVERRIDE_REQUIRED",
  "ASSIGNMENT_BLOCKED",
  "STALE_TRANSITION",
  "ILLEGAL_TRANSITION",
  "NOT_FOUND",
  "VALIDATION",
] as const;

interface FormState {
  driverId: string;
  vehicleId: string;
  trailerId: string;
  carrierId: string;
  notes: string;
}

function initialState(current: TripAssignmentDto | null): FormState {
  return {
    driverId: current?.driverId ?? "",
    vehicleId: current?.vehicleId ?? "",
    trailerId: current?.trailerId ?? "",
    carrierId: current?.carrierId ?? "",
    notes: current?.notes ?? "",
  };
}

export interface AssignmentFormProps {
  tripId: string;
  currentStatus: TripStatus;
  currentAssignment: TripAssignmentDto | null;
  resourceOptions: TripFilterOptions;
  /** Called after any successful assign/reassign/confirm/unassign (e.g. to close a dialog). */
  onDone?: () => void;
}

export function AssignmentForm({
  tripId,
  currentStatus,
  currentAssignment,
  resourceOptions,
  onDone,
}: AssignmentFormProps) {
  const t = useTranslations("Dispatch");
  const tCommon = useTranslations("Common");

  const [form, setForm] = useState<FormState>(() => initialState(currentAssignment));
  const [overrideReason, setOverrideReason] = useState("");
  const [findings, setFindings] = useState<Finding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmUnassignOpen, setConfirmUnassignOpen] = useState(false);

  const assign = useAssignTrip(tripId);
  const reassign = useReassignTrip(tripId);
  const confirm = useConfirmAssignment(tripId);
  const unassign = useUnassignTrip(tripId);
  const check = useAssignmentCheck(tripId);

  // Reset the form when the source assignment changes (e.g. after a reassign refetch).
  useEffect(() => {
    setForm(initialState(currentAssignment));
    setOverrideReason("");
  }, [currentAssignment]);

  function set<K extends keyof FormState>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function mapError(code: string): string {
    const known = (ERROR_CODES as readonly string[]).includes(code) ? code : "REQUEST_FAILED";
    return t(`errors.${known}` as Parameters<typeof t>[0]);
  }

  // Live, server-authoritative findings: debounce a dry-run check whenever the picked resources change.
  // checkMutate is read off the hook each render; depending on the field values keeps it stable.
  const checkMutate = check.mutate;
  useEffect(() => {
    if (!form.driverId && !form.vehicleId && !form.trailerId && !form.carrierId) {
      setFindings([]);
      return;
    }
    const handle = setTimeout(() => {
      checkMutate(
        {
          driverId: form.driverId || undefined,
          vehicleId: form.vehicleId || undefined,
          trailerId: form.trailerId || undefined,
          carrierId: form.carrierId || undefined,
        },
        {
          onSuccess: (next) => setFindings(next),
          onError: () => setFindings([]),
        },
      );
    }, CHECK_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [form.driverId, form.vehicleId, form.trailerId, form.carrierId, checkMutate]);

  const hasBlock = useMemo(() => findings.some((f) => f.severity === "block"), [findings]);
  const hasWarn = useMemo(() => findings.some((f) => f.severity === "warn"), [findings]);
  const overrideMissing = hasWarn && overrideReason.trim() === "";

  const isReassign = currentStatus === "assigned" || currentStatus === "confirmed";
  const showConfirm = currentStatus === "assigned";
  const showUnassign = currentStatus === "assigned";

  // The primary save (assign for `received`, reassign for `assigned`/`confirmed`).
  const saveMutation = isReassign ? reassign : assign;
  const savePending = saveMutation.isPending;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    saveMutation.mutate(
      {
        driverId: form.driverId,
        vehicleId: form.vehicleId,
        trailerId: form.trailerId || undefined,
        carrierId: form.carrierId || undefined,
        expectedFromStatus: currentStatus,
        notes: form.notes.trim() || undefined,
        overrideReason: overrideReason.trim() || undefined,
      },
      {
        onSuccess: (result) => {
          setFindings(result.findings ?? []);
          onDone?.();
        },
        onError: (err: Error) => {
          if (err instanceof TripsError) {
            setError(mapError(err.code));
            if (err.findings) setFindings(err.findings);
          } else {
            setError(mapError("REQUEST_FAILED"));
          }
        },
      },
    );
  }

  function onConfirm() {
    setError(null);
    confirm.mutate(
      { expectedFromStatus: currentStatus, notes: form.notes.trim() || undefined },
      {
        onSuccess: () => onDone?.(),
        onError: (err: Error) => {
          if (err instanceof TripsError) {
            setError(mapError(err.code));
            if (err.findings) setFindings(err.findings);
          } else {
            setError(mapError("REQUEST_FAILED"));
          }
        },
      },
    );
  }

  function onUnassign() {
    setError(null);
    unassign.mutate(
      { expectedFromStatus: currentStatus, notes: form.notes.trim() || undefined },
      {
        onSuccess: () => {
          setConfirmUnassignOpen(false);
          onDone?.();
        },
        onError: (err: Error) => {
          setConfirmUnassignOpen(false);
          setError(err instanceof TripsError ? mapError(err.code) : mapError("REQUEST_FAILED"));
        },
      },
    );
  }

  // Submit is disabled while pending, while a BLOCK is present (server refuses it anyway), or while a
  // WARN is present without an override reason — mirroring the server's OVERRIDE_REQUIRED guard.
  const saveDisabled =
    savePending || hasBlock || overrideMissing || !form.driverId || !form.vehicleId;

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ResourceSelect
            id={`driver-${tripId}`}
            label={t("driver")}
            placeholder={t("selectDriver")}
            value={form.driverId}
            options={resourceOptions.drivers}
            onChange={(v) => set("driverId", v)}
          />
          <ResourceSelect
            id={`vehicle-${tripId}`}
            label={t("vehicle")}
            placeholder={t("selectVehicle")}
            value={form.vehicleId}
            options={resourceOptions.vehicles}
            onChange={(v) => set("vehicleId", v)}
          />
          <ResourceSelect
            id={`trailer-${tripId}`}
            label={t("trailer")}
            placeholder={t("selectTrailer")}
            value={form.trailerId}
            options={resourceOptions.trailers}
            clearable
            clearLabel={t("noTrailer")}
            onChange={(v) => set("trailerId", v)}
          />
          <ResourceSelect
            id={`carrier-${tripId}`}
            label={t("carrier")}
            placeholder={t("selectCarrier")}
            value={form.carrierId}
            options={resourceOptions.carriers}
            clearable
            clearLabel={t("noCarrier")}
            onChange={(v) => set("carrierId", v)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`notes-${tripId}`}>{t("notes")}</Label>
          <textarea
            id={`notes-${tripId}`}
            rows={2}
            placeholder={t("notesPlaceholder")}
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
          />
        </div>

        {/* Live, server-authoritative eligibility findings (US2) */}
        <FindingsList findings={findings} loading={check.isPending} />

        {/* Override reason — required whenever a WARN is present (US3 / T045) */}
        {hasWarn ? (
          <div className="space-y-1.5">
            <Label htmlFor={`override-${tripId}`}>{t("overrideReasonLabel")}</Label>
            <textarea
              id={`override-${tripId}`}
              rows={2}
              placeholder={t("overrideReasonPlaceholder")}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              aria-required="true"
            />
          </div>
        ) : null}

        {hasBlock ? (
          <p role="alert" className="text-sm text-destructive">
            {t("findingsBlockingHint")}
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={saveDisabled}>
            {savePending ? t("assigning") : isReassign ? t("reassign") : t("assign")}
          </Button>
          {showConfirm ? (
            <Button
              type="button"
              variant="secondary"
              onClick={onConfirm}
              disabled={confirm.isPending}
            >
              {confirm.isPending ? t("confirming") : t("confirm")}
            </Button>
          ) : null}
          {showUnassign ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmUnassignOpen(true)}
              disabled={unassign.isPending}
            >
              {t("unassign")}
            </Button>
          ) : null}
        </div>
      </form>

      {/* Unassign confirmation dialog */}
      <Dialog open={confirmUnassignOpen} onOpenChange={setConfirmUnassignOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("unassignConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("unassignConfirmBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmUnassignOpen(false)}
              disabled={unassign.isPending}
            >
              {tCommon("cancel")}
            </Button>
            <Button type="button" variant="destructive" onClick={onUnassign} disabled={unassign.isPending}>
              {unassign.isPending ? t("unassigning") : t("unassignConfirmAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** A labelled resource `Select`, with an optional "none" clear item for trailer/carrier. */
function ResourceSelect({
  id,
  label,
  placeholder,
  value,
  options,
  onChange,
  clearable,
  clearLabel,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (value: string) => void;
  clearable?: boolean;
  clearLabel?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value || undefined}
        onValueChange={(v) => onChange(v === NONE ? "" : v)}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {clearable ? <SelectItem value={NONE}>{clearLabel}</SelectItem> : null}
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
