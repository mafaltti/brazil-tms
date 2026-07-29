CREATE TYPE "public"."billing_adjustment_type" AS ENUM('toll', 'waiting_time', 'redelivery', 'extra_stop', 'penalty', 'discount', 'manual_adjustment');--> statement-breakpoint
CREATE TYPE "public"."document_verification_status" AS ENUM('pending_review', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."export_batch_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "document_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"label_pt" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_types_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"document_type_id" uuid NOT NULL,
	"file_storage_key" text,
	"external_reference" text,
	"uploaded_by_user_id" uuid NOT NULL,
	"verification_status" "document_verification_status" DEFAULT 'pending_review' NOT NULL,
	"verified_by_user_id" uuid,
	"verified_at" timestamp with time zone,
	"waived_at" timestamp with time zone,
	"waived_reason" text,
	"waived_by_user_id" uuid,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_file_or_waiver_ck" CHECK ("documents"."file_storage_key" IS NOT NULL OR "documents"."waived_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "document_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"document_type_id" uuid NOT NULL,
	"required_for_completion" boolean DEFAULT false NOT NULL,
	"required_for_billing" boolean DEFAULT true NOT NULL,
	"lane_id" uuid,
	"vehicle_type" "vehicle_type",
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"lane_id" uuid,
	"vehicle_type" "vehicle_type",
	"base_amount_cents" bigint NOT NULL,
	"currency" text DEFAULT 'BRL' NOT NULL,
	"toll_handling_rule" text,
	"waiting_time_rule" text,
	"extra_stop_rule" text,
	"effective_start" timestamp with time zone,
	"effective_end" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "export_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"billing_period" text NOT NULL,
	"format" text NOT NULL,
	"file_storage_key" text,
	"generated_by_user_id" uuid NOT NULL,
	"status" "export_batch_status" DEFAULT 'queued' NOT NULL,
	"trip_count" integer DEFAULT 0 NOT NULL,
	"total_amount_cents" bigint DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "export_batches_format_ck" CHECK ("export_batches"."format" IN ('csv','xlsx'))
);
--> statement-breakpoint
CREATE TABLE "billing_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"rate_id" uuid,
	"base_freight_cents" bigint,
	"currency" text DEFAULT 'BRL' NOT NULL,
	"billing_period" text NOT NULL,
	"dispute_status" text DEFAULT 'none' NOT NULL,
	"export_batch_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_items_dispute_status_ck" CHECK ("billing_items"."dispute_status" IN ('none','open','resolved'))
);
--> statement-breakpoint
CREATE TABLE "billing_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_item_id" uuid NOT NULL,
	"type" "billing_adjustment_type" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"note" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_document_type_id_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_waived_by_user_id_users_id_fk" FOREIGN KEY ("waived_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_requirements" ADD CONSTRAINT "document_requirements_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_requirements" ADD CONSTRAINT "document_requirements_document_type_id_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_requirements" ADD CONSTRAINT "document_requirements_lane_id_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "public"."lanes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rates" ADD CONSTRAINT "rates_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rates" ADD CONSTRAINT "rates_lane_id_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "public"."lanes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_batches" ADD CONSTRAINT "export_batches_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_batches" ADD CONSTRAINT "export_batches_generated_by_user_id_users_id_fk" FOREIGN KEY ("generated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_items" ADD CONSTRAINT "billing_items_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_items" ADD CONSTRAINT "billing_items_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_items" ADD CONSTRAINT "billing_items_rate_id_rates_id_fk" FOREIGN KEY ("rate_id") REFERENCES "public"."rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_items" ADD CONSTRAINT "billing_items_export_batch_id_export_batches_id_fk" FOREIGN KEY ("export_batch_id") REFERENCES "public"."export_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_adjustments" ADD CONSTRAINT "billing_adjustments_billing_item_id_billing_items_id_fk" FOREIGN KEY ("billing_item_id") REFERENCES "public"."billing_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_adjustments" ADD CONSTRAINT "billing_adjustments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_adjustments" ADD CONSTRAINT "billing_adjustments_removed_by_user_id_users_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_trip_idx" ON "documents" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "documents_type_idx" ON "documents" USING btree ("document_type_id");--> statement-breakpoint
CREATE INDEX "documents_verification_idx" ON "documents" USING btree ("verification_status");--> statement-breakpoint
CREATE INDEX "document_requirements_customer_idx" ON "document_requirements" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "document_requirements_scope_idx" ON "document_requirements" USING btree ("customer_id","lane_id","vehicle_type");--> statement-breakpoint
CREATE INDEX "rates_customer_idx" ON "rates" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "rates_scope_idx" ON "rates" USING btree ("customer_id","lane_id","vehicle_type");--> statement-breakpoint
CREATE INDEX "export_batches_customer_idx" ON "export_batches" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "export_batches_created_idx" ON "export_batches" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "billing_items_trip_uq" ON "billing_items" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "billing_items_customer_period_idx" ON "billing_items" USING btree ("customer_id","billing_period");--> statement-breakpoint
CREATE INDEX "billing_items_export_batch_idx" ON "billing_items" USING btree ("export_batch_id");--> statement-breakpoint
CREATE INDEX "billing_adjustments_item_idx" ON "billing_adjustments" USING btree ("billing_item_id");