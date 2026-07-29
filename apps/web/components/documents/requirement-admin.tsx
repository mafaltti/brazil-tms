"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { VEHICLE_TYPE_VALUES } from "@brazil-tms/shared";
import type { TripFilterOptions } from "@/lib/trips/trips-read";
import {
  useCreateDocumentRequirement,
  useDocumentRequirements,
  useDocumentTypes,
  useFilterOptions,
  useUpdateDocumentRequirement,
} from "@/lib/trips/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Per-customer document-requirement checklist admin (008, US3). Pick a customer, see its checklist
 * (or the "sign-off blocked" notice when it has none — running on DEFAULT), and add a requirement
 * (type + completion/billing flags + optional lane/vehicle-type scope). Writes gated `manage_commercial_data`.
 */
export function RequirementAdmin({ options: initialOptions }: { options: TripFilterOptions }) {
  // 019 — keep the lists fresh on an open tab (60s poll + focus refetch); server data seeds it.
  const options = useFilterOptions(initialOptions);
  const t = useTranslations("Documents.requirementsAdmin");
  const tVeh = useTranslations("VehicleTypes");
  const types = useDocumentTypes();
  const create = useCreateDocumentRequirement();
  const update = useUpdateDocumentRequirement();

  const [customerId, setCustomerId] = useState("");
  const list = useDocumentRequirements(customerId || undefined);

  const [documentTypeId, setDocumentTypeId] = useState("");
  const [requiredForCompletion, setRequiredForCompletion] = useState(false);
  const [requiredForBilling, setRequiredForBilling] = useState(true);
  const [laneId, setLaneId] = useState("");
  const [vehicleType, setVehicleType] = useState("");

  const locationCode = useMemo(
    () => new Map(options.locations.map((l) => [l.id, l.code])),
    [options.locations],
  );
  const customerLanes = options.lanes.filter((l) => l.customerId === customerId);
  const activeTypes = (types.data?.items ?? []).filter((x) => x.active);
  const rows = list.data?.items ?? [];

  const onAdd = () => {
    if (!customerId || !documentTypeId) return;
    create.mutate(
      {
        customerId,
        documentTypeId,
        requiredForCompletion,
        requiredForBilling,
        laneId: laneId || undefined,
        vehicleType: (vehicleType || undefined) as never,
        active: true,
      },
      {
        onSuccess: () => {
          setDocumentTypeId("");
          setLaneId("");
          setVehicleType("");
          setRequiredForCompletion(false);
          setRequiredForBilling(true);
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
        <div className="space-y-1.5 sm:max-w-xs">
          <Label htmlFor="req-customer">{t("customer")}</Label>
          <Select value={customerId || undefined} onValueChange={setCustomerId}>
            <SelectTrigger id="req-customer">
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

        {customerId ? (
          <>
            {rows.length === 0 ? (
              <p className="text-xs text-amber-700">{t("blocked")}</p>
            ) : (
              <ul className="space-y-2">
                {rows.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
                    <span className="font-medium">{r.documentTypeLabelPt}</span>
                    {r.requiredForCompletion ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {t("requiredForCompletion")}
                      </span>
                    ) : null}
                    {r.requiredForBilling ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {t("requiredForBilling")}
                      </span>
                    ) : null}
                    {r.laneLabel ? <span className="text-muted-foreground">{r.laneLabel}</span> : null}
                    {r.vehicleType ? (
                      <span className="text-muted-foreground">{r.vehicleType}</span>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto"
                      onClick={() => update.mutate({ id: r.id, input: { active: !r.active } })}
                    >
                      {r.active ? "✓" : "—"} {t("active")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="grid grid-cols-1 gap-3 border-t pt-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="req-type">{t("type")}</Label>
                <Select value={documentTypeId || undefined} onValueChange={setDocumentTypeId}>
                  <SelectTrigger id="req-type">
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    {activeTypes.map((x) => (
                      <SelectItem key={x.id} value={x.id}>
                        {x.labelPt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="req-lane">{t("lane")}</Label>
                <Select value={laneId || undefined} onValueChange={setLaneId}>
                  <SelectTrigger id="req-lane">
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
                <Label htmlFor="req-vt">{t("vehicleType")}</Label>
                <Select value={vehicleType || undefined} onValueChange={setVehicleType}>
                  <SelectTrigger id="req-vt">
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
              <div className="flex items-end gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={requiredForCompletion}
                    onChange={(e) => setRequiredForCompletion(e.target.checked)}
                  />
                  {t("requiredForCompletion")}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={requiredForBilling}
                    onChange={(e) => setRequiredForBilling(e.target.checked)}
                  />
                  {t("requiredForBilling")}
                </label>
              </div>
            </div>
            <Button size="sm" onClick={onAdd} disabled={!documentTypeId || create.isPending}>
              {t("add")}
            </Button>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
