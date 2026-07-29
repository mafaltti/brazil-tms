"use client";

import { Controller, useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import {
  createLocationSchema,
  UF_VALUES,
  type CreateLocationInput,
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

export interface LocationFormProps {
  defaultValues?: Partial<CreateLocationInput>;
  submitting: boolean;
  errorMessage?: string | null;
  submitLabel?: string;
  onSubmit: (values: CreateLocationInput) => void;
  onCancel: () => void;
}

/** Create/edit form for a location (US2). Validates with the shared `createLocationSchema`. */
export function LocationForm({
  defaultValues,
  submitting,
  errorMessage,
  submitLabel,
  onSubmit,
  onCancel,
}: LocationFormProps) {
  const t = useTranslations("MasterData.locations");

  // Customer picker — active customers only (the BFF list excludes archived by default).
  const customers = useEntityList<CustomerDto>("customers", {});

  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateLocationInput>({
    resolver: zodResolver(createLocationSchema) as Resolver<CreateLocationInput>,
    defaultValues: {
      customerId: "",
      code: "",
      name: "",
      address: "",
      city: "",
      country: "BR",
      gateInstructions: "",
      ...defaultValues,
    },
  });

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

      <Field label={t("code")} htmlFor="code" required error={errors.code?.message}>
        <Input id="code" {...register("code")} />
      </Field>

      <Field label={t("name")} htmlFor="name" required error={errors.name?.message}>
        <Input id="name" {...register("name")} />
      </Field>

      <Field label={t("address")} htmlFor="address" error={errors.address?.message}>
        <Input id="address" {...register("address")} />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label={t("city")} htmlFor="city" error={errors.city?.message}>
          <Input id="city" {...register("city")} />
        </Field>

        <Field label={t("state")} htmlFor="state" error={errors.state?.message}>
          <Controller
            control={control}
            name="state"
            render={({ field }) => (
              <Select value={field.value || undefined} onValueChange={field.onChange}>
                <SelectTrigger id="state">
                  <SelectValue placeholder={t("state")} />
                </SelectTrigger>
                <SelectContent>
                  {UF_VALUES.map((uf) => (
                    <SelectItem key={uf} value={uf}>
                      {uf}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </Field>

        <Field label={t("country")} htmlFor="country" error={errors.country?.message}>
          <Input id="country" {...register("country")} />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t("latitude")} htmlFor="latitude" error={errors.latitude?.message}>
          <Input id="latitude" type="number" step="any" {...register("latitude")} />
        </Field>

        <Field label={t("longitude")} htmlFor="longitude" error={errors.longitude?.message}>
          <Input id="longitude" type="number" step="any" {...register("longitude")} />
        </Field>
      </div>

      <Field
        label={t("gateInstructions")}
        htmlFor="gateInstructions"
        error={errors.gateInstructions?.message}
      >
        <Input id="gateInstructions" {...register("gateInstructions")} />
      </Field>
    </EntityFormShell>
  );
}
