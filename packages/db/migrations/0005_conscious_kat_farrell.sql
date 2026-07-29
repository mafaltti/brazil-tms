CREATE TABLE "trip_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"driver_id" uuid,
	"vehicle_id" uuid,
	"trailer_id" uuid,
	"carrier_id" uuid,
	"assigned_by_user_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_by_user_id" uuid,
	"confirmed_at" timestamp with time zone,
	"notes" text,
	"override_reason" text,
	"is_current" boolean DEFAULT true NOT NULL,
	"superseded_by_assignment_id" uuid,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trip_assignments" ADD CONSTRAINT "trip_assignments_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_assignments" ADD CONSTRAINT "trip_assignments_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_assignments" ADD CONSTRAINT "trip_assignments_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_assignments" ADD CONSTRAINT "trip_assignments_trailer_id_trailers_id_fk" FOREIGN KEY ("trailer_id") REFERENCES "public"."trailers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_assignments" ADD CONSTRAINT "trip_assignments_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_assignments" ADD CONSTRAINT "trip_assignments_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_assignments" ADD CONSTRAINT "trip_assignments_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_assignments" ADD CONSTRAINT "trip_assignments_superseded_by_assignment_id_trip_assignments_id_fk" FOREIGN KEY ("superseded_by_assignment_id") REFERENCES "public"."trip_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trip_assignments_trip_active_uq" ON "trip_assignments" USING btree ("trip_id") WHERE "trip_assignments"."is_current";--> statement-breakpoint
CREATE INDEX "trip_assignments_trip_idx" ON "trip_assignments" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "trip_assignments_driver_active_idx" ON "trip_assignments" USING btree ("driver_id") WHERE "trip_assignments"."is_current";--> statement-breakpoint
CREATE INDEX "trip_assignments_vehicle_active_idx" ON "trip_assignments" USING btree ("vehicle_id") WHERE "trip_assignments"."is_current";--> statement-breakpoint
CREATE INDEX "trip_assignments_trailer_active_idx" ON "trip_assignments" USING btree ("trailer_id") WHERE "trip_assignments"."is_current";--> statement-breakpoint
CREATE INDEX "trip_assignments_carrier_active_idx" ON "trip_assignments" USING btree ("carrier_id") WHERE "trip_assignments"."is_current";