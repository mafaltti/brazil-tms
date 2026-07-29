CREATE TYPE "public"."import_batch_status" AS ENUM('received', 'parsing', 'validating', 'validated', 'confirming', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."import_row_match" AS ENUM('new', 'update', 'no_op', 'potential_duplicate', 'unresolved');--> statement-breakpoint
CREATE TYPE "public"."import_row_outcome" AS ENUM('valid', 'warning', 'error');--> statement-breakpoint
CREATE TABLE "import_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"file_type" text NOT NULL,
	"column_mappings" jsonb NOT NULL,
	"parsing_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"required_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_templates_file_type_ck" CHECK ("import_templates"."file_type" in ('csv','xlsx'))
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"template_id" uuid,
	"file_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"status" "import_batch_status" DEFAULT 'received' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"error_report_storage_key" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"mapped" jsonb,
	"outcome" "import_row_outcome",
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"match_decision" "import_row_match",
	"target_trip_id" uuid,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"customer_label" text NOT NULL,
	"internal_status" "trip_status" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"file_value" text NOT NULL,
	"location_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_templates" ADD CONSTRAINT "import_templates_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_template_id_import_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."import_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_target_trip_id_trips_id_fk" FOREIGN KEY ("target_trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_mappings" ADD CONSTRAINT "status_mappings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_aliases" ADD CONSTRAINT "location_aliases_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_aliases" ADD CONSTRAINT "location_aliases_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_aliases" ADD CONSTRAINT "location_aliases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "import_templates_customer_name_version_uq" ON "import_templates" USING btree ("customer_id","name","version");--> statement-breakpoint
CREATE INDEX "import_batches_customer_idx" ON "import_batches" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "import_batches_created_idx" ON "import_batches" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "import_rows_batch_row_uq" ON "import_rows" USING btree ("import_batch_id","row_number");--> statement-breakpoint
CREATE INDEX "import_rows_batch_outcome_idx" ON "import_rows" USING btree ("import_batch_id","outcome");--> statement-breakpoint
CREATE UNIQUE INDEX "status_mappings_customer_label_uq" ON "status_mappings" USING btree ("customer_id","customer_label");--> statement-breakpoint
CREATE UNIQUE INDEX "location_aliases_customer_file_value_uq" ON "location_aliases" USING btree ("customer_id","file_value");--> statement-breakpoint
-- Feature 004, data-model.md §6: activate slice-003's forward hook. `trips.import_batch_id` was
-- left as a bare nullable uuid by 003 ("import batches owned by 004"); drizzle-kit cannot infer this
-- cross-feature FK from the schema, so it is hand-added here. Every imported trip links to its batch.
ALTER TABLE "trips" ADD CONSTRAINT "trips_import_batch_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;