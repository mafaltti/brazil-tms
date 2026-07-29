"use client";

import {
  Controller,
  type Control,
  type FieldError,
  type FieldValues,
  type Merge,
  type Path,
} from "react-hook-form";
import { useTranslations } from "next-intl";
import {
  OWNERSHIP_TYPE_VALUES,
  RESOURCE_STATUS_VALUES,
  type OwnershipType,
} from "@brazil-tms/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/master-data/entity-form";
import { useEntityList } from "@/lib/master-data/client";

/**
 * Shared form fields for the three operational resources — drivers, vehicles, trailers (T072; ≥3
 * consumers, Constitution I / ≥3 rule). These three forms share the ownership/carrier conditional,
 * the operational-status select, the documentation-expiry date input, and a generic enum select
 * (vehicleType/trailerType). Each is a thin react-hook-form `Controller` wrapper over the shadcn
 * `Select`/`Input`, labeled via the existing `Resources.*` / `ResourceStatus.*` / `Ownership.*`
 * i18n. The carrier list is fetched from the carriers BFF endpoint via `useEntityList` — never by
 * importing the carriers service (BFF is the boundary).
 */

/** Minimal carrier shape the picker needs (the full carrier DTO lives in the carriers slice). */
export type CarrierOption = { id: string; name: string; archived: boolean };

/**
 * Narrow a react-hook-form field error to its plain string message. The three resource schemas use a
 * top-level `.refine()` (ownership/carrier), which widens `FieldErrors[field].message` to a union;
 * the `Field` component only takes `string | undefined`, so each form coerces through this.
 */
export type FieldMessage =
  | string
  | FieldError
  | Merge<FieldError, Record<string, unknown>>
  | undefined;
export function fieldMessage(error: FieldMessage): string | undefined {
  if (error == null) return undefined;
  if (typeof error === "string") return error;
  const message = (error as FieldError).message;
  return typeof message === "string" ? message : undefined;
}

interface OwnershipCarrierFieldsProps<T extends FieldValues> {
  control: Control<T>;
  /** Live ownershipType value, so the carrier picker shows/hides reactively. */
  ownershipType: OwnershipType | undefined;
  ownershipName: Path<T>;
  carrierName: Path<T>;
  ownershipError?: string;
  carrierError?: string;
  /** Called when ownership flips to "owned" so the form can clear the picked carrier (invariant). */
  onClearCarrier: () => void;
}

/**
 * Ownership select + a conditional carrier picker. `subcontracted` ⇒ a REQUIRED carrier picker
 * (active carriers only); `owned` ⇒ the carrier is hidden and cleared (FR-022/FR-023). The DB CHECK
 * and the shared Zod refinement are the hard enforcement; this is the UX mirror.
 */
export function OwnershipCarrierFields<T extends FieldValues>({
  control,
  ownershipType,
  ownershipName,
  carrierName,
  ownershipError,
  carrierError,
  onClearCarrier,
}: OwnershipCarrierFieldsProps<T>) {
  const t = useTranslations("Resources");
  const tOwnership = useTranslations("Ownership");

  // Active carriers only (archived ones cannot be newly linked — data-model §Relationships).
  const carriersQuery = useEntityList<CarrierOption>("carriers", {});
  const carriers = (carriersQuery.data ?? []).filter((c) => !c.archived);

  return (
    <>
      <Field label={t("ownership")} htmlFor={ownershipName} required error={ownershipError}>
        <Controller
          control={control}
          name={ownershipName}
          render={({ field }) => (
            <Select
              value={(field.value as string | undefined) ?? ""}
              onValueChange={(value) => {
                field.onChange(value);
                // Switching to "owned" clears any previously-picked carrier (invariant).
                if (value === "owned") onClearCarrier();
              }}
            >
              <SelectTrigger id={ownershipName}>
                <SelectValue placeholder={t("ownership")} />
              </SelectTrigger>
              <SelectContent>
                {OWNERSHIP_TYPE_VALUES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {tOwnership(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </Field>

      {ownershipType === "subcontracted" ? (
        <Field label={t("carrier")} htmlFor={carrierName} required error={carrierError}>
          <Controller
            control={control}
            name={carrierName}
            render={({ field }) => (
              <Select
                value={(field.value as string | undefined) ?? ""}
                onValueChange={field.onChange}
              >
                <SelectTrigger id={carrierName}>
                  <SelectValue placeholder={t("selectCarrier")} />
                </SelectTrigger>
                <SelectContent>
                  {carriers.map((carrier) => (
                    <SelectItem key={carrier.id} value={carrier.id}>
                      {carrier.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </Field>
      ) : null}
    </>
  );
}

interface StatusSelectProps<T extends FieldValues> {
  control: Control<T>;
  name: Path<T>;
  error?: string;
}

/** Operational `resource_status` select (RES-007). Labels from the `ResourceStatus` namespace. */
export function ResourceStatusSelect<T extends FieldValues>({
  control,
  name,
  error,
}: StatusSelectProps<T>) {
  const t = useTranslations("Resources");
  const tStatus = useTranslations("ResourceStatus");
  return (
    <Field label={t("status")} htmlFor={name} error={error}>
      <Controller
        control={control}
        name={name}
        render={({ field }) => (
          <Select
            value={(field.value as string | undefined) ?? "active"}
            onValueChange={field.onChange}
          >
            <SelectTrigger id={name}>
              <SelectValue placeholder={t("status")} />
            </SelectTrigger>
            <SelectContent>
              {RESOURCE_STATUS_VALUES.map((value) => (
                <SelectItem key={value} value={value}>
                  {tStatus(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      />
    </Field>
  );
}

interface EnumSelectProps<T extends FieldValues> {
  control: Control<T>;
  name: Path<T>;
  label: string;
  placeholder?: string;
  values: readonly string[];
  /** Localized label for a value (e.g. VehicleTypes/TrailerTypes namespace). */
  labelFor: (value: string) => string;
  required?: boolean;
  error?: string;
}

/** Generic required enum select for `vehicleType` / `trailerType`. */
export function EnumSelect<T extends FieldValues>({
  control,
  name,
  label,
  placeholder,
  values,
  labelFor,
  required,
  error,
}: EnumSelectProps<T>) {
  return (
    <Field label={label} htmlFor={name} required={required} error={error}>
      <Controller
        control={control}
        name={name}
        render={({ field }) => (
          <Select
            value={(field.value as string | undefined) ?? ""}
            onValueChange={field.onChange}
          >
            <SelectTrigger id={name}>
              <SelectValue placeholder={placeholder ?? label} />
            </SelectTrigger>
            <SelectContent>
              {values.map((value) => (
                <SelectItem key={value} value={value}>
                  {labelFor(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      />
    </Field>
  );
}

interface ExpiryDateFieldProps {
  label: string;
  htmlFor: string;
  error?: string;
  /** register("licenseExpiry") | register("documentExpiry") spread props. */
  registration: Record<string, unknown>;
}

/** Documentation-expiry date input (`<input type="date">` yields YYYY-MM-DD, matching the schema). */
export function ExpiryDateField({ label, htmlFor, error, registration }: ExpiryDateFieldProps) {
  return (
    <Field label={label} htmlFor={htmlFor} error={error}>
      <Input id={htmlFor} type="date" {...registration} />
    </Field>
  );
}
