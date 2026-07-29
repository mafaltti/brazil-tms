"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { VEHICLE_TYPE_VALUES } from "@brazil-tms/shared";
import type { TripFilterOptions } from "@/lib/trips/trips-read";
import { useCreateRate, useFilterOptions, useRates } from "@/lib/trips/client";
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

function brl(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

function reaisToCents(input: string): number | null {
  const n = input.replace(/\./g, "").replace(",", ".").trim();
  if (n === "") return null;
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) : null;
}

/**
 * Rate admin (008, US4). Lists rates (customer/lane/vehicle-type/effective/base) and adds new ones.
 * The toll/waiting/extra-stop rule fields are labeled gated §29 Input #5 placeholders. Writes gated
 * `edit_rates`.
 */
export function RateAdmin({ options: initialOptions }: { options: TripFilterOptions }) {
  // 019 — keep the lists fresh on an open tab (60s poll + focus refetch); server data seeds it.
  const options = useFilterOptions(initialOptions);
  const t = useTranslations("Rates");
  const tVeh = useTranslations("VehicleTypes");
  const rates = useRates();
  const create = useCreateRate();

  const [customerId, setCustomerId] = useState("");
  const [laneId, setLaneId] = useState("");
  const [vehicleType, setVehicleType] = useState("");
  const [baseAmount, setBaseAmount] = useState("");
  const [effectiveStart, setEffectiveStart] = useState("");
  const [effectiveEnd, setEffectiveEnd] = useState("");

  const locationCode = useMemo(
    () => new Map(options.locations.map((l) => [l.id, l.code])),
    [options.locations],
  );
  const customerLanes = options.lanes.filter((l) => l.customerId === customerId);
  const rows = rates.data?.items ?? [];

  const onCreate = () => {
    const cents = reaisToCents(baseAmount);
    if (!customerId || cents == null) return;
    create.mutate(
      {
        customerId,
        laneId: laneId || undefined,
        vehicleType: (vehicleType || undefined) as never,
        baseAmountCents: cents,
        currency: "BRL",
        effectiveStart: effectiveStart ? new Date(effectiveStart) : undefined,
        effectiveEnd: effectiveEnd ? new Date(effectiveEnd) : undefined,
        active: true,
      },
      {
        onSuccess: () => {
          setBaseAmount("");
          setLaneId("");
          setVehicleType("");
          setEffectiveStart("");
          setEffectiveEnd("");
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
                <span className="font-medium">{r.customerName}</span>
                <span className="text-muted-foreground">{r.laneLabel ?? "—"}</span>
                {r.vehicleType ? <span className="text-muted-foreground">{r.vehicleType}</span> : null}
                <span className="ml-auto font-semibold tabular-nums">{brl(r.baseAmountCents)}</span>
                {!r.active ? <span className="text-xs text-muted-foreground">{t("inactiveTag")}</span> : null}
              </li>
            ))}
          </ul>
        )}

        <div className="grid grid-cols-1 gap-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="rate-customer">{t("customer")}</Label>
            <Select value={customerId || undefined} onValueChange={setCustomerId}>
              <SelectTrigger id="rate-customer">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {options.customers.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rate-lane">{t("lane")}</Label>
            <Select value={laneId || undefined} onValueChange={setLaneId} disabled={!customerId}>
              <SelectTrigger id="rate-lane">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {customerLanes.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {locationCode.get(l.originLocationId) ?? "?"} →{" "}
                    {locationCode.get(l.destinationLocationId) ?? "?"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rate-vt">{t("vehicleType")}</Label>
            <Select value={vehicleType || undefined} onValueChange={setVehicleType}>
              <SelectTrigger id="rate-vt">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {VEHICLE_TYPE_VALUES.map((vt) => (
                  <SelectItem key={vt} value={vt}>
                    {(() => {
                      try {
                        return tVeh(vt as Parameters<typeof tVeh>[0]);
                      } catch {
                        return vt;
                      }
                    })()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rate-base">{t("baseAmount")}</Label>
            <Input id="rate-base" inputMode="decimal" value={baseAmount} onChange={(e) => setBaseAmount(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rate-start">{t("effectiveStart")}</Label>
            <Input id="rate-start" type="date" value={effectiveStart} onChange={(e) => setEffectiveStart(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rate-end">{t("effectiveEnd")}</Label>
            <Input id="rate-end" type="date" value={effectiveEnd} onChange={(e) => setEffectiveEnd(e.target.value)} />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t("rulesNote")}</p>
        <Button size="sm" onClick={onCreate} disabled={!customerId || reaisToCents(baseAmount) == null || create.isPending}>
          {t("add")}
        </Button>
      </CardContent>
    </Card>
  );
}
