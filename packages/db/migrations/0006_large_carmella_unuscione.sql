CREATE TYPE "public"."exception_responsible_party" AS ENUM('customer_caused', 'brazil_transports_caused', 'carrier_caused', 'force_majeure', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."exception_severity" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."exception_status" AS ENUM('open', 'monitoring', 'resolved', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."trip_event_type" ADD VALUE 'note';--> statement-breakpoint
CREATE TABLE "reason_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"category" text NOT NULL,
	"label_pt" text NOT NULL,
	"default_severity" "exception_severity" NOT NULL,
	"default_responsible_party" "exception_responsible_party" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reason_codes_code_unique" UNIQUE("code"),
	CONSTRAINT "reason_codes_category_ck" CHECK ("reason_codes"."category" IN ('delay','no_show','breakdown','driver_issue','customer_delay','loading_delay','unloading_delay','documentation','accident','route_deviation','cancellation','other'))
);
--> statement-breakpoint
CREATE TABLE "exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"reason_code_id" uuid NOT NULL,
	"severity" "exception_severity" NOT NULL,
	"status" "exception_status" DEFAULT 'open' NOT NULL,
	"responsible_party" "exception_responsible_party" NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"description" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"closure_notes" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_sla_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"lane_id" uuid,
	"vehicle_type" "vehicle_type",
	"pickup_tolerance_minutes" integer NOT NULL,
	"delivery_tolerance_minutes" integer NOT NULL,
	"confirmation_cutoff_minutes" integer NOT NULL,
	"at_risk_warning_minutes" integer NOT NULL,
	"effective_start" timestamp with time zone,
	"effective_end" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"alert_case" text NOT NULL,
	"severity" "exception_severity" NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_by_user_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"auto_resolved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alerts_case_ck" CHECK ("alerts"."alert_case" IN ('unassigned_within_window','unconfirmed_within_window','missed_origin_arrival','missed_departure','missed_destination_arrival','high_severity_exception','completed_missing_documents','billing_blocked_missing_proof')),
	CONSTRAINT "alerts_state_ck" CHECK ("alerts"."state" IN ('active','acknowledged','resolved'))
);
--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "sla_reasons" text[];--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_reason_code_id_reason_codes_id_fk" FOREIGN KEY ("reason_code_id") REFERENCES "public"."reason_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_sla_rules" ADD CONSTRAINT "customer_sla_rules_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_sla_rules" ADD CONSTRAINT "customer_sla_rules_lane_id_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "public"."lanes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_acknowledged_by_user_id_users_id_fk" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exceptions_trip_idx" ON "exceptions" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "exceptions_status_idx" ON "exceptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "exceptions_severity_idx" ON "exceptions" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "exceptions_owner_idx" ON "exceptions" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "exceptions_reason_idx" ON "exceptions" USING btree ("reason_code_id");--> statement-breakpoint
CREATE INDEX "exceptions_opened_idx" ON "exceptions" USING btree ("opened_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "customer_sla_rules_customer_idx" ON "customer_sla_rules" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_sla_rules_scope_idx" ON "customer_sla_rules" USING btree ("customer_id","lane_id","vehicle_type");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_trip_case_open_uq" ON "alerts" USING btree ("trip_id","alert_case") WHERE "alerts"."state" IN ('active', 'acknowledged');--> statement-breakpoint
CREATE INDEX "alerts_trip_idx" ON "alerts" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "alerts_state_idx" ON "alerts" USING btree ("state");--> statement-breakpoint
ALTER TABLE "trip_events" ADD CONSTRAINT "trip_events_exception_id_exceptions_id_fk" FOREIGN KEY ("exception_id") REFERENCES "public"."exceptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_sla_status_ck" CHECK ("trips"."sla_status" IS NULL OR "trips"."sla_status" IN ('on_track','at_risk','late','breached'));