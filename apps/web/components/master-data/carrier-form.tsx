"use client";

import { Controller, useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import {
  CARRIER_CONTRACT_STATUS_VALUES,
  CARRIER_DOCUMENTATION_STATUS_VALUES,
  createCarrierSchema,
  type CreateCarrierInput,
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

export interface CarrierFormProps {
  defaultValues?: Partial<CreateCarrierInput>;
  submitting: boolean;
  errorMessage?: string | null;
  submitLabel?: string;
  onSubmit: (values: CreateCarrierInput) => void;
  onCancel: () => void;
}

/** Create/edit form for a carrier (US4). Validates with the shared `createCarrierSchema`. */
export function CarrierForm({
  defaultValues,
  submitting,
  errorMessage,
  submitLabel,
  onSubmit,
  onCancel,
}: CarrierFormProps) {
  const t = useTranslations("Resources.carriers");
  const tContract = useTranslations("CarrierContractStatus");
  const tDoc = useTranslations("CarrierDocStatus");

  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateCarrierInput>({
    resolver: zodResolver(createCarrierSchema) as Resolver<CreateCarrierInput>,
    defaultValues: {
      name: "",
      legalName: "",
      taxId: "",
      contractStatus: "active",
      documentationStatus: "pending",
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
      <Field label={t("name")} htmlFor="name" required error={errors.name?.message}>
        <Input id="name" {...register("name")} />
      </Field>

      <Field label={t("legalName")} htmlFor="legalName" error={errors.legalName?.message}>
        <Input id="legalName" {...register("legalName")} />
      </Field>

      <Field label={t("taxId")} htmlFor="taxId" error={errors.taxId?.message}>
        <Input id="taxId" {...register("taxId")} />
      </Field>

      <Field label={t("contractStatus")} htmlFor="contractStatus" error={errors.contractStatus?.message}>
        <Controller
          control={control}
          name="contractStatus"
          render={({ field }) => (
            <Select value={field.value ?? "active"} onValueChange={field.onChange}>
              <SelectTrigger id="contractStatus">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CARRIER_CONTRACT_STATUS_VALUES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {tContract(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </Field>

      <Field
        label={t("documentationStatus")}
        htmlFor="documentationStatus"
        error={errors.documentationStatus?.message}
      >
        <Controller
          control={control}
          name="documentationStatus"
          render={({ field }) => (
            <Select value={field.value ?? "pending"} onValueChange={field.onChange}>
              <SelectTrigger id="documentationStatus">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CARRIER_DOCUMENTATION_STATUS_VALUES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {tDoc(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </Field>

      <div className="space-y-2 rounded-md border p-3">
        <span className="text-sm font-medium">{t("contactName")}</span>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Input placeholder={t("contactName")} {...register("contact.name")} />
          <Input placeholder={t("contactEmail")} {...register("contact.email")} />
          <Input placeholder={t("contactPhone")} {...register("contact.phone")} />
          <Input placeholder={t("contactAddress")} {...register("contact.address")} />
        </div>
      </div>
    </EntityFormShell>
  );
}
