import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Feature 016 — internal agregados freight rate table (spec FR-005, data-model.md).
 * Replace-all semantics: `freight_rates` always holds exactly the content of the latest
 * successful upload; `freight_rate_imports` records each replace (rejected files leave no row).
 * Money is integer centavos (house convention — `rates.base_amount_cents`); `vehicle_type` is a
 * free-form uppercased label from the sheet, NOT the fleet `vehicle_type` enum (research R3).
 */
export const freightRateImports = pgTable(
  "freight_rate_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileName: text("file_name").notNull(),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    routeCount: integer("route_count").notNull(),
    rateCount: integer("rate_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("freight_rate_imports_created_idx").on(table.createdAt.desc())],
);

export const freightRates = pgTable(
  "freight_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importId: uuid("import_id")
      .notNull()
      .references(() => freightRateImports.id),
    originUf: text("origin_uf").notNull(),
    originCity: text("origin_city").notNull(),
    destinationUf: text("destination_uf").notNull(),
    destinationCity: text("destination_city").notNull(),
    km: integer("km"),
    vehicleType: text("vehicle_type").notNull(),
    valorIdaCents: bigint("valor_ida_cents", { mode: "number" }),
    valorReversaCents: bigint("valor_reversa_cents", { mode: "number" }),
    observacoes: text("observacoes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("freight_rates_unique_idx").on(
      table.originUf,
      table.originCity,
      table.destinationUf,
      table.destinationCity,
      table.vehicleType,
    ),
    index("freight_rates_origin_idx").on(table.originUf, table.originCity),
    index("freight_rates_destination_idx").on(table.destinationUf, table.destinationCity),
  ],
);
