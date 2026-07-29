"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { VEHICLE_TYPE_VALUES, type CreateSlaRuleInput } from "@brazil-tms/shared";
import type { TripFilterOptions } from "@/lib/trips/trips-read";
import { TripsError, useCreateSlaRule, useCustomerSlaRules, useFilterOptions } from "@/lib/trips/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Per-customer SLA-rule admin (007, US5). Lists existing rules (customer / scope / the four minute
 * fields / active) and a create form. Surfaces "SLA sign-off blocked" for customers with NO rule
 * (they run on the company `DEFAULT_SLA_POLICY` — FR-022). Admin writes reuse `manage_commercial_data`
 * (server-enforced). pt-BR throughout.
 */

const ANY = "__any__";

export function SlaRuleAdmin({ options: initialOptions }: { options: TripFilterOptions }) {
  // 019 — keep the lists fresh on an open tab (60s poll + focus refetch); server data seeds it.
  const options = useFilterOptions(initialOptions);
  const t = useTranslations("Sla.rules");
  const tErr = useTranslations("Sla.errors");
  const tVehicle = useTranslations("VehicleTypes");
  const rules = useCustomerSlaRules();
  const createRule = useCreateSlaRule();

  const [customerId, setCustomerId] = useState("");
  const [laneId, setLaneId] = useState("");
  const [vehicleType, setVehicleType] = useState("");
  const [pickup, setPickup] = useState("0");
  const [delivery, setDelivery] = useState("0");
  const [cutoff, setCutoff] = useState("120");
  const [warning, setWarning] = useState("60");
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const items = rules.data?.items ?? [];

  // Customers WITHOUT any rule → SLA sign-off blocked (running on company defaults).
  const customersWithRule = useMemo(() => new Set(items.map((r) => r.customerId)), [items]);
  const blockedCustomers = options.customers.filter((c) => !customersWithRule.has(c.id));

  const laneLabel = (l: TripFilterOptions["lanes"][number]): string => {
    const o = options.locations.find((x) => x.id === l.originLocationId)?.code ?? "?";
    const d = options.locations.find((x) => x.id === l.destinationLocationId)?.code ?? "?";
    return `${o} → ${d}`;
  };

  // A lane-scoped rule must reference one of the SELECTED customer's lanes (a cross-customer lane would
  // never match that customer's trips). Show only this customer's lanes; pick a customer first.
  const customerLanes = options.lanes.filter((l) => l.customerId === customerId);

  const mapError = (e: unknown): string => {
    const code = e instanceof TripsError ? e.code : "REQUEST_FAILED";
    try {
      return tErr(code as Parameters<typeof tErr>[0]);
    } catch {
      return tErr("REQUEST_FAILED");
    }
  };

  const onCreate = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setFeedback(null);
    if (!customerId) return;
    const input: CreateSlaRuleInput = {
      customerId,
      laneId: laneId || undefined,
      vehicleType: (vehicleType || undefined) as CreateSlaRuleInput["vehicleType"],
      pickupToleranceMinutes: Number(pickup),
      deliveryToleranceMinutes: Number(delivery),
      confirmationCutoffMinutes: Number(cutoff),
      atRiskWarningMinutes: Number(warning),
    };
    createRule.mutate(input, {
      onSuccess: () => {
        setFeedback(t("saveSuccess"));
        setCustomerId("");
        setLaneId("");
        setVehicleType("");
      },
      onError: (err) => setError(mapError(err)),
    });
  };

  return (
    <div className="space-y-6">
      {/* Existing rules */}
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {rules.isLoading ? (
            <Skeleton className="m-4 h-40" />
          ) : rules.isError ? (
            <p role="alert" className="p-4 text-sm text-destructive">
              {t("loadError")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("customer")}</TableHead>
                  <TableHead>{t("lane")}</TableHead>
                  <TableHead>{t("vehicleType")}</TableHead>
                  <TableHead>{t("pickupTolerance")}</TableHead>
                  <TableHead>{t("deliveryTolerance")}</TableHead>
                  <TableHead>{t("confirmationCutoff")}</TableHead>
                  <TableHead>{t("atRiskWarning")}</TableHead>
                  <TableHead>{t("active")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="h-20 text-center text-muted-foreground">
                      {t("empty")}
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{r.customerName ?? "—"}</TableCell>
                      <TableCell>{r.laneLabel ?? t("anyLane")}</TableCell>
                      <TableCell>{r.vehicleType ?? t("anyVehicle")}</TableCell>
                      <TableCell className="tabular-nums">{r.pickupToleranceMinutes}</TableCell>
                      <TableCell className="tabular-nums">{r.deliveryToleranceMinutes}</TableCell>
                      <TableCell className="tabular-nums">{r.confirmationCutoffMinutes}</TableCell>
                      <TableCell className="tabular-nums">{r.atRiskWarningMinutes}</TableCell>
                      <TableCell>{r.active ? "✓" : "—"}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Customers without a rule — SLA sign-off blocked (running on company defaults). */}
      {blockedCustomers.length > 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">{t("blockedSignOff")}</p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {blockedCustomers.map((c) => (
                <li key={c.id} className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
                  {c.name}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {/* Create form */}
      <Card>
        <CardHeader>
          <CardTitle>{t("create")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreate} className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="sla-customer">{t("customer")}</Label>
                <Select
                  value={customerId || undefined}
                  onValueChange={(v) => {
                    setCustomerId(v);
                    setLaneId(""); // clear any lane from the previously-selected customer
                  }}
                >
                  <SelectTrigger id="sla-customer">
                    <SelectValue placeholder={t("customer")} />
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
                <Label htmlFor="sla-lane">{t("lane")}</Label>
                <Select
                  value={laneId || ANY}
                  onValueChange={(v) => setLaneId(v === ANY ? "" : v)}
                  disabled={!customerId}
                >
                  <SelectTrigger id="sla-lane">
                    <SelectValue placeholder={t("anyLane")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>{t("anyLane")}</SelectItem>
                    {customerLanes.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {laneLabel(l)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sla-vehicle">{t("vehicleType")}</Label>
                <Select
                  value={vehicleType || ANY}
                  onValueChange={(v) => setVehicleType(v === ANY ? "" : v)}
                >
                  <SelectTrigger id="sla-vehicle">
                    <SelectValue placeholder={t("anyVehicle")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>{t("anyVehicle")}</SelectItem>
                    {VEHICLE_TYPE_VALUES.map((vt) => (
                      <SelectItem key={vt} value={vt}>
                        {tVehicle(vt)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MinuteField id="sla-pickup" label={t("pickupTolerance")} value={pickup} onChange={setPickup} />
              <MinuteField id="sla-delivery" label={t("deliveryTolerance")} value={delivery} onChange={setDelivery} />
              <MinuteField id="sla-cutoff" label={t("confirmationCutoff")} value={cutoff} onChange={setCutoff} />
              <MinuteField id="sla-warning" label={t("atRiskWarning")} value={warning} onChange={setWarning} />
            </div>

            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {feedback ? <p className="text-sm text-emerald-700">{feedback}</p> : null}

            <Button type="submit" disabled={createRule.isPending || !customerId}>
              {createRule.isPending ? t("saving") : t("save")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function MinuteField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" min={0} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
