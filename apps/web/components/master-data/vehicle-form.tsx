"use client";

import { useForm, useWatch, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import {
  createVehicleSchema,
  VEHICLE_TYPE_VALUES,
  type CreateVehicleInput,
} from "@brazil-tms/shared";
import { Input } from "@/components/ui/input";
import { EntityFormShell, Field } from "@/components/master-data/entity-form";
import {
  EnumSelect,
  ExpiryDateField,
  fieldMessage,
  OwnershipCarrierFields,
  ResourceStatusSelect,
} from "@/components/master-data/resource-form-fields";

export interface VehicleFormProps {
  defaultValues?: Partial<CreateVehicleInput>;
  submitting: boolean;
  errorMessage?: string | null;
  submitLabel?: string;
  onSubmit: (values: CreateVehicleInput) => void;
  onCancel: () => void;
}

/** Create/edit form for a vehicle (US3). Validates with the shared `createVehicleSchema`. */
export function VehicleForm({
  defaultValues,
  submitting,
  errorMessage,
  submitLabel,
  onSubmit,
  onCancel,
}: VehicleFormProps) {
  const t = useTranslations("Resources.vehicles");
  const tResources = useTranslations("Resources");
  const tTypes = useTranslations("VehicleTypes");

  const {
    register,
    control,
    setValue,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateVehicleInput>({
    resolver: zodResolver(createVehicleSchema) as Resolver<CreateVehicleInput>,
    defaultValues: {
      plate: "",
      vehicleType: undefined,
      anttNumber: "",
      renavam: "",
      chassis: "",
      capacityKg: undefined,
      ownershipType: "owned",
      carrierId: "",
      owner: "",
      trackerProvider: "",
      trackerId: "",
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
      {/* Issue #30 [0007]: the registry identifiers sit together (Placa/Tipo/Renavam/ANTT) and
          Capacidade shares a half-width row with Chassi instead of spanning the form. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t("plate")} htmlFor="plate" required error={fieldMessage(errors.plate)}>
          <Input id="plate" {...register("plate")} />
        </Field>
        <EnumSelect
          control={control}
          name="vehicleType"
          label={t("vehicleType")}
          values={VEHICLE_TYPE_VALUES}
          labelFor={(value) => tTypes(value)}
          required
          error={fieldMessage(errors.vehicleType)}
        />
        <Field label={t("renavam")} htmlFor="renavam" error={fieldMessage(errors.renavam)}>
          <Input id="renavam" inputMode="numeric" {...register("renavam")} />
        </Field>
        <Field label={t("anttNumber")} htmlFor="anttNumber" error={fieldMessage(errors.anttNumber)}>
          <Input id="anttNumber" {...register("anttNumber")} />
        </Field>
        <Field label={t("chassis")} htmlFor="chassis" error={fieldMessage(errors.chassis)}>
          <Input id="chassis" {...register("chassis")} />
        </Field>
        <Field label={t("capacityKg")} htmlFor="capacityKg" error={fieldMessage(errors.capacityKg)}>
          <Input id="capacityKg" type="number" min={0} {...register("capacityKg")} />
        </Field>
      </div>

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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label={t("trackerProvider")}
          htmlFor="trackerProvider"
          error={fieldMessage(errors.trackerProvider)}
        >
          <Input id="trackerProvider" {...register("trackerProvider")} />
        </Field>
        <Field label={t("trackerId")} htmlFor="trackerId" error={fieldMessage(errors.trackerId)}>
          <Input id="trackerId" {...register("trackerId")} />
        </Field>
      </div>

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
