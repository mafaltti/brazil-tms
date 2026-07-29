"use client";

import { useForm, useFieldArray, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { createCustomerSchema, type CreateCustomerInput } from "@brazil-tms/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EntityFormShell, Field } from "@/components/master-data/entity-form";

export interface CustomerFormProps {
  defaultValues?: Partial<CreateCustomerInput>;
  submitting: boolean;
  errorMessage?: string | null;
  submitLabel?: string;
  onSubmit: (values: CreateCustomerInput) => void;
  onCancel: () => void;
}

/** Create/edit form for a customer (US1). Validates with the shared `createCustomerSchema`. */
export function CustomerForm({
  defaultValues,
  submitting,
  errorMessage,
  submitLabel,
  onSubmit,
  onCancel,
}: CustomerFormProps) {
  const t = useTranslations("MasterData.customers");

  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateCustomerInput>({
    resolver: zodResolver(createCustomerSchema) as Resolver<CreateCustomerInput>,
    defaultValues: {
      name: "",
      legalName: "",
      customerCode: "",
      taxId: "",
      contacts: [],
      ...defaultValues,
    },
  });

  const contacts = useFieldArray({ control, name: "contacts" });

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

      <Field label={t("code")} htmlFor="customerCode" required error={errors.customerCode?.message}>
        <Input id="customerCode" {...register("customerCode")} />
      </Field>

      <Field label={t("taxId")} htmlFor="taxId" error={errors.taxId?.message}>
        <Input id="taxId" {...register("taxId")} />
      </Field>

      <div className="space-y-3 rounded-md border p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{t("contacts")}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => contacts.append({ name: "" })}
          >
            {t("addContact")}
          </Button>
        </div>
        {contacts.fields.map((field, index) => (
          <div key={field.id} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Input
              placeholder={t("contactName")}
              aria-label={`${t("contactName")} ${index + 1}`}
              {...register(`contacts.${index}.name` as const)}
            />
            <Input placeholder={t("contactEmail")} {...register(`contacts.${index}.email` as const)} />
            <Input placeholder={t("contactPhone")} {...register(`contacts.${index}.phone` as const)} />
            <div className="flex gap-2">
              <Input
                placeholder={t("contactRole")}
                {...register(`contacts.${index}.role` as const)}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => contacts.remove(index)}
              >
                {t("removeContact")}
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-2 rounded-md border p-3">
        <span className="text-sm font-medium">{t("billingContact")}</span>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Input placeholder={t("contactName")} {...register("billingContact.name")} />
          <Input placeholder={t("contactEmail")} {...register("billingContact.email")} />
          <Input placeholder={t("contactPhone")} {...register("billingContact.phone")} />
        </div>
      </div>
    </EntityFormShell>
  );
}
