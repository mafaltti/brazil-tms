"use client";

import { useForm, useWatch, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import {
  createTrailerSchema,
  TRAILER_TYPE_VALUES,
  type CreateTrailerInput,
} from "@brazil-tms/shared";
import { Input } from "@/components/ui/input";
import { DocumentReadButton } from "@/components/master-data/document-read-button";
import { EntityFormShell, Field } from "@/components/master-data/entity-form";
import {
  EnumSelect,
  ExpiryDateField,
  fieldMessage,
  OwnershipCarrierFields,
  ResourceStatusSelect,
} from "@/components/master-data/resource-form-fields";

export interface TrailerFormProps {
  defaultValues?: Partial<CreateTrailerInput>;
  submitting: boolean;
  errorMessage?: string | null;
  submitLabel?: string;
  onSubmit: (values: CreateTrailerInput) => void;
  onCancel: () => void;
}

/** Create/edit form for a trailer (US3). Validates with the shared `createTrailerSchema`. */
export function TrailerForm({
  defaultValues,
  submitting,
  errorMessage,
  submitLabel,
  onSubmit,
  onCancel,
}: TrailerFormProps) {
  const t = useTranslations("Resources.trailers");
  const tResources = useTranslations("Resources");
  const tTypes = useTranslations("TrailerTypes");

  const {
    register,
    control,
    setValue,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateTrailerInput>({
    resolver: zodResolver(createTrailerSchema) as Resolver<CreateTrailerInput>,
    defaultValues: {
      plate: "",
      trailerType: undefined,
      capacityKg: undefined,
      ownershipType: "owned",
      carrierId: "",
      owner: "",
      documentExpiry: "",
      status: "active",
      notes: "",
      ...defaultValues,
    },
  });

  const ownershipType = useWatch({ control, name: "ownershipType" });

  return (
    <EntityFormShell
      submitting={submitting}
      errorMessage={errorMessage}
      submitLabel={submitLabel}
      onCancel={onCancel}
      onSubmit={handleSubmit((values) => onSubmit(values))}
    >
      {/* 021 (issue #29) — CRLV read prefills plate/validity for REVIEW (trailer type is a
          different catalog, so the CRLV vehicleType is intentionally NOT mapped here). */}
      <DocumentReadButton
        docType="crlv"
        fieldLabels={{
          plate: t("plate"),
          documentExpiry: t("documentExpiry"),
        }}
        onExtracted={(fields) => {
          for (const [key, value] of Object.entries(fields)) {
            setValue(key as "plate" | "documentExpiry", value, {
              shouldDirty: true,
              shouldValidate: true,
            });
          }
        }}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t("plate")} htmlFor="plate" required error={fieldMessage(errors.plate)}>
          <Input id="plate" {...register("plate")} />
        </Field>
        <EnumSelect
          control={control}
          name="trailerType"
          label={t("trailerType")}
          values={TRAILER_TYPE_VALUES}
          labelFor={(value) => tTypes(value)}
          required
          error={fieldMessage(errors.trailerType)}
        />
      </div>

      <Field label={t("capacityKg")} htmlFor="capacityKg" error={fieldMessage(errors.capacityKg)}>
        <Input id="capacityKg" type="number" min={0} {...register("capacityKg")} />
      </Field>

      <OwnershipCarrierFields
        control={control}
        ownershipType={ownershipType}
        ownershipName="ownershipType"
        carrierName="carrierId"
        ownershipError={fieldMessage(errors.ownershipType)}
        carrierError={fieldMessage(errors.carrierId)}
        onClearCarrier={() => setValue("carrierId", "")}
      />

      <Field label={t("owner")} htmlFor="owner" error={fieldMessage(errors.owner)}>
        <Input id="owner" {...register("owner")} />
      </Field>

      <ExpiryDateField
        label={t("documentExpiry")}
        htmlFor="documentExpiry"
        error={fieldMessage(errors.documentExpiry)}
        registration={register("documentExpiry")}
      />

      <ResourceStatusSelect control={control} name="status" error={fieldMessage(errors.status)} />

      <Field label={tResources("notes")} htmlFor="notes" error={fieldMessage(errors.notes)}>
        <Input id="notes" {...register("notes")} />
      </Field>
    </EntityFormShell>
  );
}
