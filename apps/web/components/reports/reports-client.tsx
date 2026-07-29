"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { TripFilterOptions } from "@/lib/trips/trips-read";
import { useFilterOptions } from "@/lib/trips/client";
import { cn } from "@/lib/utils";
import { ReportFilters, type ReportFiltersValue } from "@/components/reports/report-filters";
import { SlaReport } from "@/components/reports/sla-report";
import { ExceptionReport } from "@/components/reports/exception-report";
import { BillingReadinessReport } from "@/components/reports/billing-readiness-report";

/**
 * Feature 009 — the Reports screen shell (US1–US3). Three tabs (SLA · Exceções · Prontidão de
 * cobrança) over a shared customer/lane/period filter bar; freshness is polling (no Realtime). Each
 * tab body is its own report component (filled per story). The billing tab is customer-only, so the
 * lane picker + grouping are hidden there. Filter state is component-local (the screen is self-contained).
 */

type Tab = "sla" | "exceptions" | "billing";

/** Build the report-filter query string from the filter state (only non-empty values). */
export function reportSearch(value: ReportFiltersValue): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(value)) {
    if (v != null && v !== "") params.set(k, v);
  }
  return params.toString();
}

export function ReportsClient({ options: initialOptions }: { options: TripFilterOptions }) {
  // 019 — keep the lists fresh on an open tab (60s poll + focus refetch); server data seeds it.
  const options = useFilterOptions(initialOptions);
  const t = useTranslations("Reports");
  const [tab, setTab] = useState<Tab>("sla");
  const [filters, setFilters] = useState<ReportFiltersValue>({});
  const search = useMemo(() => reportSearch(filters), [filters]);

  const tabs: { key: Tab; label: string }[] = [
    { key: "sla", label: t("tabs.sla") },
    { key: "exceptions", label: t("tabs.exceptions") },
    { key: "billing", label: t("tabs.billingReadiness") },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b" role="tablist" aria-label={t("title")}>
        {tabs.map((x) => (
          <button
            key={x.key}
            type="button"
            role="tab"
            aria-selected={tab === x.key}
            onClick={() => setTab(x.key)}
            className={cn(
              "-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors",
              tab === x.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {x.label}
          </button>
        ))}
      </div>

      <ReportFilters
        value={filters}
        onChange={setFilters}
        options={options}
        showLaneAndGroup={tab !== "billing"}
      />

      {/* Tab bodies — filled per story (US1 SLA, US2 Exceções, US3 Prontidão de cobrança). */}
      {tab === "sla" ? <SlaReport search={search} /> : null}
      {tab === "exceptions" ? <ExceptionReport search={search} /> : null}
      {tab === "billing" ? <BillingReadinessReport search={search} /> : null}
    </div>
  );
}
