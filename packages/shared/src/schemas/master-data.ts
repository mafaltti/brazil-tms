import { z } from "zod";

/**
 * Shared Zod schemas for feature 002 master data (data-model.md §Validation; pt-BR messages).
 * One create/update schema per entity, imported by BOTH the BFF route handlers and the
 * react-hook-form screens (DRY). Building blocks (contacts, CNPJ, plate, UF, money, enums, the
 * ownership/carrier refinement) are defined once and reused across the seven entities.
 *
 * The DB also enforces the hard invariants (UNIQUE, CHECK, FK); these schemas catch shape/format
 * errors at the boundary (400) before a row is touched, and the services surface DB conflicts (409).
 *
 * Optional fields coerce empty-string form inputs to `undefined` (HTML inputs yield "" when blank),
 * and numeric fields coerce numeric strings, so the same schema validates both JSON bodies and forms.
 */

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

/**
 * Optional field that distinguishes "absent" from "cleared". A blank input ("" or null) becomes
 * explicit `null` (so an edit can CLEAR the column, and switching a resource to `owned` with a blank
 * carrier nulls `carrier_id`); a missing key stays `undefined` (so the partial-update services skip
 * it and leave the column unchanged).
 */
const blankable = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === "" || v === null ? null : v), schema.nullable().optional());

/** Optional nested object: an all-blank object collapses to `null` (cleared); absent stays undefined. */
const optionalObject = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v === "object") {
      const hasValue = Object.values(v as Record<string, unknown>).some(
        (x) => x !== "" && x != null,
      );
      if (!hasValue) return null;
    }
    return v;
  }, schema.nullable().optional());

const optionalText = (max = 200) =>
  blankable(z.string().trim().max(max, `Máximo de ${max} caracteres.`));

/** Email that is optional but, when present, must be valid (blank → undefined). */
const optionalEmail = blankable(z.string().trim().email("E-mail inválido."));

/** Wrap a numeric schema so "" / null become undefined and numeric strings become numbers. */
const numberFromInput = (schema: z.ZodNumber) =>
  z.preprocess((v) => {
    if (v === undefined) return undefined;
    if (v === "" || v === null) return null;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isNaN(n) ? v : n;
    }
    return v;
  }, schema.nullable().optional());

// ---------------------------------------------------------------------------
// Primitive building blocks
// ---------------------------------------------------------------------------

const nameSchema = z
  .string()
  .trim()
  .min(1, "Informe o nome.")
  .max(200, "O nome deve ter no máximo 200 caracteres.");

/** CNPJ — basic format check only (R7): 14 digits after stripping punctuation. */
export const cnpjSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/\D/g, ""))
  .pipe(z.string().length(14, "CNPJ deve ter 14 dígitos."));

const optionalCnpj = blankable(cnpjSchema);

/**
 * CPF — punctuated ("390.533.447-05") or bare digits only (FR-002). Strips ONLY the supported
 * separators (dot/hyphen/space); any other character must FAIL the digit check below, never be
 * silently discarded ("abc390.533.447-05xyz" is rejected, not coerced). Format check only — no
 * check digits (R7 posture).
 */
export const cpfSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/[.\-\s]/g, ""))
  .pipe(z.string().regex(/^\d{11}$/, "CPF deve ter 11 dígitos."));

const optionalCpf = blankable(cpfSchema);

/** BR/Mercosul plate (R11): normalized to uppercase, hyphen/space stripped. */
export const plateSchema = z
  .string()
  .trim()
  .min(1, "Informe a placa.")
  .transform((s) => s.toUpperCase().replace(/[\s-]/g, ""))
  .pipe(
    z
      .string()
      .regex(/^[A-Z]{3}[0-9][0-9A-Z][0-9]{2}$/, "Placa inválida (formato BR/Mercosul)."),
  );

/** Brazilian state (UF) — closed 2-letter set. */
export const ufSchema = z.enum(
  [
    "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG",
    "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
  ],
  { errorMap: () => ({ message: "UF inválida." }) },
);
export const UF_VALUES = ufSchema.options;
const optionalUf = blankable(ufSchema);

/** Non-negative integer amount of centavos (BRL, R7). */
export const moneyCentsSchema = z
  .number({ invalid_type_error: "Valor inválido." })
  .int("O valor deve ser um inteiro em centavos.")
  .nonnegative("O valor não pode ser negativo.");

/** Date as an ISO calendar day string (YYYY-MM-DD). */
export const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida (use AAAA-MM-DD).");
const optionalDate = blankable(dateStringSchema);

export const latitudeSchema = z.number().min(-90, "Latitude inválida.").max(90, "Latitude inválida.");
export const longitudeSchema = z
  .number()
  .min(-180, "Longitude inválida.")
  .max(180, "Longitude inválida.");

/** A contact entry (R8 — stored as jsonb, validated here). */
export const contactSchema = z.object({
  name: z.string().trim().min(1, "Informe o nome do contato.").max(200),
  email: optionalEmail,
  phone: optionalText(40),
  role: optionalText(80),
});
export type Contact = z.infer<typeof contactSchema>;

/** Billing contact — like a contact but without a role. */
export const billingContactSchema = z.object({
  name: z.string().trim().min(1, "Informe o nome do contato.").max(200),
  email: optionalEmail,
  phone: optionalText(40),
});

// ---------------------------------------------------------------------------
// Enum schemas (mirror the Postgres enums in packages/db/schema/enums.ts)
// ---------------------------------------------------------------------------

export const resourceStatusSchema = z.enum(
  ["active", "inactive", "unavailable", "maintenance", "blocked"],
  { errorMap: () => ({ message: "Status inválido." }) },
);
export const RESOURCE_STATUS_VALUES = resourceStatusSchema.options;
export type ResourceStatus = z.infer<typeof resourceStatusSchema>;

export const ownershipTypeSchema = z.enum(["owned", "subcontracted"], {
  errorMap: () => ({ message: "Tipo de propriedade inválido." }),
});
export const OWNERSHIP_TYPE_VALUES = ownershipTypeSchema.options;
export type OwnershipType = z.infer<typeof ownershipTypeSchema>;

export const vehicleTypeSchema = z.enum(
  [
    "van",
    "vuc",
    "tres_quartos",
    "toco",
    "truck",
    "bitruck",
    "carreta",
    "carreta_ls",
    "bitrem",
    "rodotrem",
  ],
  { errorMap: () => ({ message: "Tipo de veículo inválido." }) },
);
export const VEHICLE_TYPE_VALUES = vehicleTypeSchema.options;
export type VehicleType = z.infer<typeof vehicleTypeSchema>;

export const trailerTypeSchema = z.enum(
  ["sider", "bau", "graneleiro", "tanque", "frigorifico", "prancha", "cacamba", "porta_container"],
  { errorMap: () => ({ message: "Tipo de reboque inválido." }) },
);
export const TRAILER_TYPE_VALUES = trailerTypeSchema.options;
export type TrailerType = z.infer<typeof trailerTypeSchema>;

export const carrierContractStatusSchema = z.enum(["active", "suspended", "expired"], {
  errorMap: () => ({ message: "Status de contrato inválido." }),
});
export const CARRIER_CONTRACT_STATUS_VALUES = carrierContractStatusSchema.options;

export const carrierDocumentationStatusSchema = z.enum(["pending", "complete", "expired"], {
  errorMap: () => ({ message: "Status de documentação inválido." }),
});
export const CARRIER_DOCUMENTATION_STATUS_VALUES = carrierDocumentationStatusSchema.options;

// ---------------------------------------------------------------------------
// Ownership/carrier invariant (mirror of the DB CHECK — FR-022/FR-023)
// ---------------------------------------------------------------------------

/** subcontracted ⇒ carrierId set; owned ⇒ carrierId absent. `undefined` ownership (partial update) passes. */
export function isOwnershipCarrierValid(data: {
  ownershipType?: OwnershipType;
  carrierId?: string | null;
}): boolean {
  if (data.ownershipType === undefined) return true;
  if (data.ownershipType === "subcontracted") return Boolean(data.carrierId);
  return !data.carrierId; // owned ⇒ no carrier
}

const OWNERSHIP_CARRIER_REFINE = {
  message:
    "Recurso subcontratado exige uma transportadora; recurso próprio não pode ter transportadora.",
  path: ["carrierId"],
};

/** Apply the ownership/carrier invariant to any schema with `ownershipType` + `carrierId`. */
export const ownershipCarrierRefine = <T extends z.ZodTypeAny>(schema: T) =>
  schema.refine(isOwnershipCarrierValid, OWNERSHIP_CARRIER_REFINE);

const carrierIdField = blankable(z.string().uuid("Transportadora inválida."));

// ---------------------------------------------------------------------------
// 1. Customer (US1)
// ---------------------------------------------------------------------------

const customerBase = z.object({
  name: nameSchema,
  legalName: optionalText(200),
  customerCode: z
    .string()
    .trim()
    .min(1, "Informe o código do cliente.")
    .max(60, "Código muito longo."),
  taxId: optionalCnpj,
  contacts: z.array(contactSchema).optional().default([]),
  billingContact: optionalObject(billingContactSchema),
});

export const createCustomerSchema = customerBase;
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = customerBase.partial();
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

// ---------------------------------------------------------------------------
// 2. Location (US2)
// ---------------------------------------------------------------------------

const locationBase = z.object({
  customerId: z.string().uuid("Cliente inválido."),
  code: z.string().trim().min(1, "Informe o código.").max(60, "Código muito longo."),
  name: nameSchema,
  address: optionalText(300),
  city: optionalText(120),
  state: optionalUf,
  country: z.string().trim().length(2, "País inválido.").default("BR"),
  latitude: numberFromInput(latitudeSchema),
  longitude: numberFromInput(longitudeSchema),
  gateInstructions: optionalText(1000),
});

export const createLocationSchema = locationBase;
export type CreateLocationInput = z.infer<typeof createLocationSchema>;

export const updateLocationSchema = locationBase.partial();
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;

// ---------------------------------------------------------------------------
// 3. Lane (US2)
// ---------------------------------------------------------------------------

const laneBase = z.object({
  customerId: z.string().uuid("Cliente inválido."),
  originLocationId: z.string().uuid("Origem inválida."),
  destinationLocationId: z.string().uuid("Destino inválido."),
  expectedTransitMinutes: numberFromInput(z.number().int().nonnegative()),
  defaultVehicleType: blankable(vehicleTypeSchema),
  standardRateCents: numberFromInput(moneyCentsSchema),
  tollEstimateCents: numberFromInput(moneyCentsSchema),
  standardDistanceKm: numberFromInput(z.number().nonnegative("A distância não pode ser negativa.")),
});

/** origin ≠ destination (degenerate-lane guard, mirrors the DB CHECK). */
const laneNotDegenerate = (data: {
  originLocationId?: string;
  destinationLocationId?: string;
}): boolean =>
  data.originLocationId === undefined ||
  data.destinationLocationId === undefined ||
  data.originLocationId !== data.destinationLocationId;

const LANE_DEGENERATE_REFINE = {
  message: "A origem e o destino devem ser locais diferentes.",
  path: ["destinationLocationId"],
};

export const createLaneSchema = laneBase.refine(laneNotDegenerate, LANE_DEGENERATE_REFINE);
export type CreateLaneInput = z.infer<typeof createLaneSchema>;

export const updateLaneSchema = laneBase.partial().refine(laneNotDegenerate, LANE_DEGENERATE_REFINE);
export type UpdateLaneInput = z.infer<typeof updateLaneSchema>;

// ---------------------------------------------------------------------------
// 4. Driver (US3/US4)
// ---------------------------------------------------------------------------

const driverBase = z.object({
  name: nameSchema,
  phone: optionalText(40),
  // Issue #28 [0005]: CPF replaced the driver e-mail; the DB `email` column is dormant.
  cpf: optionalCpf,
  licenseNumber: optionalText(40),
  licenseCategory: optionalText(8),
  licenseExpiry: optionalDate,
  ownershipType: ownershipTypeSchema,
  carrierId: carrierIdField,
  employer: optionalText(200),
  status: resourceStatusSchema.optional(),
  notes: optionalText(2000),
});

export const createDriverSchema = ownershipCarrierRefine(driverBase);
export type CreateDriverInput = z.infer<typeof createDriverSchema>;

export const updateDriverSchema = ownershipCarrierRefine(driverBase.partial());
export type UpdateDriverInput = z.infer<typeof updateDriverSchema>;

// ---------------------------------------------------------------------------
// 5. Vehicle (US3/US4)
// ---------------------------------------------------------------------------

const vehicleBase = z.object({
  plate: plateSchema,
  vehicleType: vehicleTypeSchema,
  capacityKg: numberFromInput(z.number().int().nonnegative()),
  ownershipType: ownershipTypeSchema,
  carrierId: carrierIdField,
  owner: optionalText(200),
  trackerProvider: optionalText(120),
  trackerId: optionalText(120),
  documentExpiry: optionalDate,
  status: resourceStatusSchema.optional(),
  notes: optionalText(2000),
});

export const createVehicleSchema = ownershipCarrierRefine(vehicleBase);
export type CreateVehicleInput = z.infer<typeof createVehicleSchema>;

export const updateVehicleSchema = ownershipCarrierRefine(vehicleBase.partial());
export type UpdateVehicleInput = z.infer<typeof updateVehicleSchema>;

// ---------------------------------------------------------------------------
// 6. Trailer (US3/US4)
// ---------------------------------------------------------------------------

const trailerBase = z.object({
  plate: plateSchema,
  trailerType: trailerTypeSchema,
  capacityKg: numberFromInput(z.number().int().nonnegative()),
  ownershipType: ownershipTypeSchema,
  carrierId: carrierIdField,
  owner: optionalText(200),
  documentExpiry: optionalDate,
  status: resourceStatusSchema.optional(),
  notes: optionalText(2000),
});

export const createTrailerSchema = ownershipCarrierRefine(trailerBase);
export type CreateTrailerInput = z.infer<typeof createTrailerSchema>;

export const updateTrailerSchema = ownershipCarrierRefine(trailerBase.partial());
export type UpdateTrailerInput = z.infer<typeof updateTrailerSchema>;

// ---------------------------------------------------------------------------
// 7. Carrier (US4)
// ---------------------------------------------------------------------------

const carrierContactSchema = z.object({
  name: optionalText(200),
  email: optionalEmail,
  phone: optionalText(40),
  address: optionalText(300),
});

const carrierBase = z.object({
  name: nameSchema,
  legalName: optionalText(200),
  taxId: optionalCnpj,
  contact: optionalObject(carrierContactSchema),
  contractStatus: carrierContractStatusSchema.optional(),
  documentationStatus: carrierDocumentationStatusSchema.optional(),
});

export const createCarrierSchema = carrierBase;
export type CreateCarrierInput = z.infer<typeof createCarrierSchema>;

export const updateCarrierSchema = carrierBase.partial();
export type UpdateCarrierInput = z.infer<typeof updateCarrierSchema>;
