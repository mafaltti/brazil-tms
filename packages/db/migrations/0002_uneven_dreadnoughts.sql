CREATE TYPE "public"."cancellation_responsible_party" AS ENUM('customer_caused', 'brazil_transports_caused', 'carrier_caused', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."trip_event_source" AS ENUM('system', 'operator_manual', 'import');--> statement-breakpoint
CREATE TYPE "public"."trip_event_type" AS ENUM('status_change', 'origin_arrived', 'loaded', 'departed', 'destination_arrived', 'unloaded', 'completed');--> statement-breakpoint
CREATE TYPE "public"."trip_status" AS ENUM('received', 'validation_error', 'validated', 'assigned', 'confirmed', 'at_origin', 'loading', 'loaded', 'in_transit', 'at_destination', 'unloading', 'unloaded', 'completed', 'billing_pending', 'billing_ready', 'billed', 'cancelled', 'disputed');--> statement-breakpoint
CREATE TABLE "trips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"external_trip_id" text,
	"import_batch_id" uuid,
	"origin_location_id" uuid NOT NULL,
	"destination_location_id" uuid NOT NULL,
	"lane_id" uuid,
	"current_status" "trip_status" DEFAULT 'received' NOT NULL,
	"sla_status" text,
	"original_plan" jsonb NOT NULL,
	"planned_pickup_window_start" timestamp with time zone,
	"planned_pickup_window_end" timestamp with time zone,
	"planned_delivery_window_start" timestamp with time zone,
	"planned_delivery_window_end" timestamp with time zone,
	"planned_vehicle_type" "vehicle_type",
	"planned_volume_units" integer,
	"planned_weight_kg" integer,
	"planned_pallet_count" integer,
	"planned_route_notes" text,
	"planned_service_requirements" jsonb,
	"cancellation_reason_code" text,
	"cancellation_responsible_party" "cancellation_responsible_party",
	"cancellation_billing_impact" text,
	"cancelled_at" timestamp with time zone,
	"disputed_from_status" "trip_status",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trips_origin_dest_ck" CHECK ("trips"."origin_location_id" <> "trips"."destination_location_id")
);
--> statement-breakpoint
CREATE TABLE "trip_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"event_type" "trip_event_type" NOT NULL,
	"status_before" "trip_status",
	"status_after" "trip_status",
	"event_timestamp" timestamp with time zone,
	"source" "trip_event_source" NOT NULL,
	"actor_user_id" uuid,
	"location_id" uuid,
	"notes" text,
	"exception_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cancellation_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"code" text NOT NULL,
	"label_pt" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cancellation_options_kind_code_uq" UNIQUE("kind","code"),
	CONSTRAINT "cancellation_options_kind_ck" CHECK ("cancellation_options"."kind" IN ('reason', 'billing_impact'))
);
--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_origin_location_id_locations_id_fk" FOREIGN KEY ("origin_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_destination_location_id_locations_id_fk" FOREIGN KEY ("destination_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_lane_id_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "public"."lanes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_events" ADD CONSTRAINT "trip_events_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_events" ADD CONSTRAINT "trip_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_events" ADD CONSTRAINT "trip_events_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trips_customer_external_id_uq" ON "trips" USING btree ("customer_id","external_trip_id") WHERE "trips"."external_trip_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "trips_customer_idx" ON "trips" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "trips_status_idx" ON "trips" USING btree ("current_status");--> statement-breakpoint
CREATE INDEX "trips_created_idx" ON "trips" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trip_events_trip_idx" ON "trip_events" USING btree ("trip_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trip_events_type_idx" ON "trip_events" USING btree ("event_type");--> statement-breakpoint
-- Append-only hardening (feature 003, data-model §Append-only enforcement; FR-017). drizzle-kit will
-- NOT emit this — mirror the audit_logs REVOKE so trip_events rows can only be inserted/selected,
-- never updated or deleted (immutable critical history, Constitution III).
REVOKE UPDATE, DELETE ON "trip_events" FROM PUBLIC;