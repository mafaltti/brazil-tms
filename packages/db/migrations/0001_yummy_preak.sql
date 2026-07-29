CREATE TYPE "public"."ownership_type" AS ENUM('owned', 'subcontracted');--> statement-breakpoint
CREATE TYPE "public"."resource_status" AS ENUM('active', 'inactive', 'unavailable', 'maintenance', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."trailer_type" AS ENUM('sider', 'bau', 'graneleiro', 'tanque', 'frigorifico', 'prancha', 'cacamba', 'porta_container');--> statement-breakpoint
CREATE TYPE "public"."vehicle_type" AS ENUM('van', 'vuc', 'tres_quartos', 'toco', 'truck', 'bitruck', 'carreta', 'carreta_ls', 'bitrem', 'rodotrem');--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"customer_code" text NOT NULL,
	"tax_id" text,
	"contacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"billing_contact" jsonb,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_customer_code_unique" UNIQUE("customer_code")
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"city" text,
	"state" text,
	"country" text DEFAULT 'BR' NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"gate_instructions" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locations_customer_code_unique" UNIQUE("customer_id","code")
);
--> statement-breakpoint
CREATE TABLE "lanes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"origin_location_id" uuid NOT NULL,
	"destination_location_id" uuid NOT NULL,
	"expected_transit_minutes" integer,
	"default_vehicle_type" "vehicle_type",
	"standard_rate_cents" bigint,
	"toll_estimate_cents" bigint,
	"standard_distance_km" numeric,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lanes_origin_dest_ck" CHECK ("lanes"."origin_location_id" <> "lanes"."destination_location_id")
);
--> statement-breakpoint
CREATE TABLE "carriers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"tax_id" text,
	"contact" jsonb,
	"contract_status" text DEFAULT 'active' NOT NULL,
	"documentation_status" text DEFAULT 'pending' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carriers_tax_id_unique" UNIQUE("tax_id"),
	CONSTRAINT "carriers_contract_status_ck" CHECK ("carriers"."contract_status" in ('active', 'suspended', 'expired')),
	CONSTRAINT "carriers_documentation_status_ck" CHECK ("carriers"."documentation_status" in ('pending', 'complete', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "drivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"license_number" text,
	"license_category" text,
	"license_expiry" date,
	"ownership_type" "ownership_type" NOT NULL,
	"carrier_id" uuid,
	"employer" text,
	"status" "resource_status" DEFAULT 'active' NOT NULL,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drivers_ownership_carrier_ck" CHECK (("drivers"."ownership_type" = 'subcontracted' AND "drivers"."carrier_id" IS NOT NULL) OR ("drivers"."ownership_type" = 'owned' AND "drivers"."carrier_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plate" text NOT NULL,
	"vehicle_type" "vehicle_type" NOT NULL,
	"capacity_kg" integer,
	"ownership_type" "ownership_type" NOT NULL,
	"carrier_id" uuid,
	"owner" text,
	"tracker_provider" text,
	"tracker_id" text,
	"document_expiry" date,
	"status" "resource_status" DEFAULT 'active' NOT NULL,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicles_plate_unique" UNIQUE("plate"),
	CONSTRAINT "vehicles_ownership_carrier_ck" CHECK (("vehicles"."ownership_type" = 'subcontracted' AND "vehicles"."carrier_id" IS NOT NULL) OR ("vehicles"."ownership_type" = 'owned' AND "vehicles"."carrier_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "trailers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plate" text NOT NULL,
	"trailer_type" "trailer_type" NOT NULL,
	"capacity_kg" integer,
	"ownership_type" "ownership_type" NOT NULL,
	"carrier_id" uuid,
	"owner" text,
	"document_expiry" date,
	"status" "resource_status" DEFAULT 'active' NOT NULL,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trailers_plate_unique" UNIQUE("plate"),
	CONSTRAINT "trailers_ownership_carrier_ck" CHECK (("trailers"."ownership_type" = 'subcontracted' AND "trailers"."carrier_id" IS NOT NULL) OR ("trailers"."ownership_type" = 'owned' AND "trailers"."carrier_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lanes" ADD CONSTRAINT "lanes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lanes" ADD CONSTRAINT "lanes_origin_location_id_locations_id_fk" FOREIGN KEY ("origin_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lanes" ADD CONSTRAINT "lanes_destination_location_id_locations_id_fk" FOREIGN KEY ("destination_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trailers" ADD CONSTRAINT "trailers_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "locations_customer_idx" ON "locations" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "lanes_customer_idx" ON "lanes" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "lanes_origin_idx" ON "lanes" USING btree ("origin_location_id");--> statement-breakpoint
CREATE INDEX "lanes_dest_idx" ON "lanes" USING btree ("destination_location_id");--> statement-breakpoint
CREATE INDEX "drivers_carrier_idx" ON "drivers" USING btree ("carrier_id");--> statement-breakpoint
CREATE INDEX "drivers_status_idx" ON "drivers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "vehicles_carrier_idx" ON "vehicles" USING btree ("carrier_id");--> statement-breakpoint
CREATE INDEX "vehicles_status_idx" ON "vehicles" USING btree ("status");--> statement-breakpoint
CREATE INDEX "trailers_carrier_idx" ON "trailers" USING btree ("carrier_id");--> statement-breakpoint
CREATE INDEX "trailers_status_idx" ON "trailers" USING btree ("status");