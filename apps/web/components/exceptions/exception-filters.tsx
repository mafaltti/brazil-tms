"use client";

import { useTranslations } from "next-intl";
import {
  EXCEPTION_SEVERITIES,
  EXCEPTION_STATUSES,
} from "@brazil-tms/shared";
import type { TripFilterOptions } from "@/lib/trips/trips-read";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Exception Management filter bar (007, US2). Controlled by the parent's `filters` map + `setFilter`
 * (kept in component state, NOT the URL — the queue is its own screen). Severity / status / customer /
 * lane / reason code / owner / minimum age. pt-BR labels; an empty value clears the filter.
 */

export interface ExceptionFiltersValue {
  severity?: string;
  status?: string;
  customerId?: string;
  laneId?: string;
  reasonCodeId?: string;
  ownerUserId?: string;
  minAgeHours?: string;
}

const ALL = "__all__";

export function ExceptionFilters({
  value,
  onChange,
  options,
}: {
  value: ExceptionFiltersValue;
  onChange: (next: ExceptionFiltersValue) => void;
  options: TripFilterOptions;
}) {
  const t = useTranslations("Exceptions");
  const tSev = useTranslations("Exceptions.severityValue");
  const tStatus = useTranslations("Exceptions.statusValue");

  const set = (key: keyof ExceptionFiltersValue, v: string | undefined) =>
    onChange({ ...value, [key]: v });

  const laneLabel = (l: TripFilterOptions["lanes"][number]): string => {
    const o = options.locations.find((x) => x.id === l.originLocationId)?.code ?? "?";
    const d = options.locations.find((x) => x.id === l.destinationLocationId)?.code ?? "?";
    return `${o} → ${d}`;
  };

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Picker
        id="exc-f-severity"
        label={t("filters.severity")}
        value={value.severity}
        allLabel={t("filters.all")}
        onChange={(v) => set("severity", v)}
        options={EXCEPTION_SEVERITIES.map((s) => ({ value: s, label: tSev(s) }))}
      />
      <Picker
        id="exc-f-status"
        label={t("filters.status")}
        value={value.status}
        allLabel={t("filters.all")}
        onChange={(v) => set("status", v)}
        options={EXCEPTION_STATUSES.map((s) => ({ value: s, label: tStatus(s) }))}
      />
      <Picker
        id="exc-f-customer"
        label={t("filters.customer")}
        value={value.customerId}
        allLabel={t("filters.all")}
        onChange={(v) => set("customerId", v)}
        options={options.customers.map((c) => ({ value: c.id, label: c.name }))}
      />
      <Picker
        id="exc-f-lane"
        label={t("filters.lane")}
        value={value.laneId}
        allLabel={t("filters.all")}
        onChange={(v) => set("laneId", v)}
        options={options.lanes.map((l) => ({ value: l.id, label: laneLabel(l) }))}
      />
      <Picker
        id="exc-f-reason"
        label={t("filters.reasonCode")}
        value={value.reasonCodeId}
        allLabel={t("filters.all")}
        onChange={(v) => set("reasonCodeId", v)}
        options={options.reasonCodes.map((r) => ({ value: r.id, label: r.labelPt }))}
      />
      <Picker
        id="exc-f-owner"
        label={t("filters.owner")}
        value={value.ownerUserId}
        allLabel={t("filters.all")}
        onChange={(v) => set("ownerUserId", v)}
        options={options.owners.map((o) => ({ value: o.id, label: o.label }))}
      />
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="exc-f-age">
          {t("filters.minAgeHours")}
        </label>
        <Input
          id="exc-f-age"
          type="number"
          min={0}
          defaultValue={value.minAgeHours ?? ""}
          onKeyDown={(e) => {
            if (e.key === "Enter") set("minAgeHours", (e.target as HTMLInputElement).value || undefined);
          }}
          onBlur={(e) => set("minAgeHours", e.target.value || undefined)}
        />
      </div>
      <div className="flex items-end">
        <Button variant="ghost" size="sm" onClick={() => onChange({})}>
          {t("filters.all")}
        </Button>
      </div>
    </div>
  );
}

function Picker({
  id,
  label,
  value,
  allLabel,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string | undefined;
  allLabel: string;
  onChange: (value: string | undefined) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : v)}>
        <SelectTrigger id={id}>
          <SelectValue placeholder={allLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{allLabel}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
