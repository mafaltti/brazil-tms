CREATE TABLE "freight_rate_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_name" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"route_count" integer NOT NULL,
	"rate_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "freight_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"origin_uf" text NOT NULL,
	"origin_city" text NOT NULL,
	"destination_uf" text NOT NULL,
	"destination_city" text NOT NULL,
	"km" integer,
	"vehicle_type" text NOT NULL,
	"valor_ida_cents" bigint,
	"valor_reversa_cents" bigint,
	"observacoes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "freight_rate_imports" ADD CONSTRAINT "freight_rate_imports_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_rates" ADD CONSTRAINT "freight_rates_import_id_freight_rate_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."freight_rate_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "freight_rate_imports_created_idx" ON "freight_rate_imports" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "freight_rates_unique_idx" ON "freight_rates" USING btree ("origin_uf","origin_city","destination_uf","destination_city","vehicle_type");--> statement-breakpoint
CREATE INDEX "freight_rates_origin_idx" ON "freight_rates" USING btree ("origin_uf","origin_city");--> statement-breakpoint
CREATE INDEX "freight_rates_destination_idx" ON "freight_rates" USING btree ("destination_uf","destination_city");