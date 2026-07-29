"use client";

import { useTranslations } from "next-intl";
import { REPORT_GROUP_BY } from "@brazil-tms/shared";
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
 * Feature 009 — the shared report filter bar (US1–US3). Customer + lane selects + a from/to São Paulo
 * calendar-day range (native date inputs → `YYYY-MM-DD`, matching `reportFilterSchema`) + an optional
 * customer/lane grouping. Controlled by the parent (`value`/`onChange`); an empty value clears the
 * filter and the read models fall back to the default period (last completed calendar month). The lane
 * picker + grouping are hidden on the billing-readiness tab (`showLaneAndGroup={false}`), which is
 * customer-only.
 */

export interface ReportFiltersValue {
  customerId?: string;
  laneId?: string;
  from?: string;
  to?: string;
  groupBy?: (typeof REPORT_GROUP_BY)[number];
}

const ALL = "__all__";

export function ReportFilters({
  value,
  onChange,
  options,
  showLaneAndGroup = true,
}: {
  value: ReportFiltersValue;
  onChange: (next: ReportFiltersValue) => void;
  options: TripFilterOptions;
  showLaneAndGroup?: boolean;
}) {
  const t = useTranslations("Reports");
  const tGroup = useTranslations("Reports.groupByValue");

  const set = (key: keyof ReportFiltersValue, v: string | undefined) =>
    onChange({ ...value, [key]: v });

  // Changing the customer must clear the lane: a lane belongs to one customer, so a previously
  // selected laneId would otherwise persist (hidden) and serialize as customerId=B&laneId=A,
  // returning empty reports. Clearing it here keeps the filter coherent.
  const setCustomer = (v: string | undefined) =>
    onChange({ ...value, customerId: v, laneId: undefined });

  const laneLabel = (l: TripFilterOptions["lanes"][number]): string => {
    const o = options.locations.find((x) => x.id === l.originLocationId)?.code ?? "?";
    const d = options.locations.find((x) => x.id === l.destinationLocationId)?.code ?? "?";
    return `${o} → ${d}`;
  };

  // When a customer is selected, narrow the lane options to that customer's lanes.
  const laneOptions = value.customerId
    ? options.lanes.filter((l) => l.customerId === value.customerId)
    : options.lanes;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Picker
        id="rep-f-customer"
        label={t("filters.customer")}
        value={value.customerId}
        allLabel={t("filters.all")}
        onChange={setCustomer}
        options={options.customers.map((c) => ({ value: c.id, label: c.name }))}
      />
      {showLaneAndGroup ? (
        <Picker
          id="rep-f-lane"
          label={t("filters.lane")}
          value={value.laneId}
          allLabel={t("filters.all")}
          onChange={(v) => set("laneId", v)}
          options={laneOptions.map((l) => ({ value: l.id, label: laneLabel(l) }))}
        />
      ) : null}
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="rep-f-from">
          {t("filters.from")}
        </label>
        <Input
          id="rep-f-from"
          type="date"
          value={value.from ?? ""}
          onChange={(e) => set("from", e.target.value || undefined)}
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="rep-f-to">
          {t("filters.to")}
        </label>
        <Input
          id="rep-f-to"
          type="date"
          value={value.to ?? ""}
          onChange={(e) => set("to", e.target.value || undefined)}
        />
      </div>
      {showLaneAndGroup ? (
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="rep-f-group">
            {t("filters.groupBy")}
          </label>
          <Select
            value={value.groupBy ?? "customer"}
            onValueChange={(v) => set("groupBy", v as ReportFiltersValue["groupBy"])}
          >
            <SelectTrigger id="rep-f-group">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REPORT_GROUP_BY.map((g) => (
                <SelectItem key={g} value={g}>
                  {tGroup(g)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <div className="flex items-end">
        <Button variant="ghost" size="sm" onClick={() => onChange({})}>
          {t("filters.clear")}
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
