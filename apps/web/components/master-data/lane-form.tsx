"use client";

import { Controller, useForm, useWatch, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import {
  createLaneSchema,
  VEHICLE_TYPE_VALUES,
  type CreateLaneInput,
} from "@brazil-tms/shared";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EntityFormShell, Field } from "@/components/master-data/entity-form";
import { useEntityList } from "@/lib/master-data/client";
import type { CustomerDto } from "@/lib/master-data/customers-service";
import type { LocationDto } from "@/lib/master-data/locations-service";

export interface LaneFormProps {
  defaultValues?: Partial<CreateLaneInput>;
  submitting: boolean;
  errorMessage?: string | null;
  submitLabel?: string;
  onSubmit: (values: CreateLaneInput) => void;
  onCancel: () => void;
}

/** Create/edit form for a lane (US2). Validates with the shared `createLaneSchema`. */
export function LaneForm({
  defaultValues,
  submitting,
  errorMessage,
  submitLabel,
  onSubmit,
  onCancel,
}: LaneFormProps) {
  const t = useTranslations("MasterData.lanes");
  const tVehicle = useTranslations("VehicleTypes");

  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateLaneInput>({
    resolver: zodResolver(createLaneSchema) as Resolver<CreateLaneInput>,
    defaultValues: {
      customerId: "",
      originLocationId: "",
      destinationLocationId: "",
      ...defaultValues,
    },
  });

  // Cascading pick-lists: choosing a customer scopes the origin/destination location lists (R5).
  const customers = useEntityList<CustomerDto>("customers", {});
  const customerId = useWatch({ control, name: "customerId" });
  const locations = useEntityList<LocationDto>(
    "locations",
    customerId ? { customerId } : undefined,
  );
  const locationItems = customerId ? (locations.data ?? []) : [];

  return (
    <EntityFormShell
      submitting={submitting}
      errorMessage={errorMessage}
      submitLabel={submitLabel}
      onCancel={onCancel}
      onSubmit={handleSubmit((values) => onSubmit(values))}
    >
      <Field label={t("customer")} htmlFor="customerId" required error={errors.customerId?.message}>
        <Controller
          control={control}
          name="customerId"
          render={({ field }) => (
            <Select value={field.value || undefined} onValueChange={field.onChange}>
              <SelectTrigger id="customerId">
                <SelectValue placeholder={t("selectCustomer")} />
              </SelectTrigger>
              <SelectContent>
                {(customers.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </Field>

      <Field
        label={t("origin")}
        htmlFor="originLocationId"
        required
        error={errors.originLocationId?.message}
      >
        <Controller
          control={control}
          name="originLocationId"
          render={({ field }) => (
            <Select
              value={field.value || undefined}
              onValueChange={field.onChange}
              disabled={!customerId}
            >
              <SelectTrigger id="originLocationId">
                <SelectValue placeholder={t("selectOrigin")} />
              </SelectTrigger>
              <SelectContent>
                {locationItems.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </Field>

      <Field
        label={t("destination")}
        htmlFor="destinationLocationId"
        required
        error={errors.destinationLocationId?.message}
      >
        <Controller
          control={control}
          name="destinationLocationId"
          render={({ field }) => (
            <Select
              value={field.value || undefined}
              onValueChange={field.onChange}
              disabled={!customerId}
            >
              <SelectTrigger id="destinationLocationId">
                <SelectValue placeholder={t("selectDestination")} />
              </SelectTrigger>
              <SelectContent>
                {locationItems.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </Field>

      <Field
        label={t("defaultVehicleType")}
        htmlFor="defaultVehicleType"
        error={errors.defaultVehicleType?.message}
      >
        <Controller
          control={control}
          name="defaultVehicleType"
          render={({ field }) => (
            <Select value={field.value || undefined} onValueChange={field.onChange}>
              <SelectTrigger id="defaultVehicleType">
                <SelectValue placeholder={t("defaultVehicleType")} />
              </SelectTrigger>
              <SelectContent>
                {VEHICLE_TYPE_VALUES.map((vt) => (
                  <SelectItem key={vt} value={vt}>
                    {tVehicle(vt)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label={t("expectedTransitMinutes")}
          htmlFor="expectedTransitMinutes"
          error={errors.expectedTransitMinutes?.message}
        >
          <Input
            id="expectedTransitMinutes"
            type="number"
            step="1"
            {...register("expectedTransitMinutes")}
          />
        </Field>

        <Field
          label={t("standardDistanceKm")}
          htmlFor="standardDistanceKm"
          error={errors.standardDistanceKm?.message}
        >
          <Input id="standardDistanceKm" type="number" step="any" {...register("standardDistanceKm")} />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label={t("standardRateCents")}
          htmlFor="standardRateCents"
          error={errors.standardRateCents?.message}
        >
          <Input id="standardRateCents" type="number" step="1" {...register("standardRateCents")} />
        </Field>

        <Field
          label={t("tollEstimateCents")}
          htmlFor="tollEstimateCents"
          error={errors.tollEstimateCents?.message}
        >
          <Input id="tollEstimateCents" type="number" step="1" {...register("tollEstimateCents")} />
        </Field>
      </div>
    </EntityFormShell>
  );
}
