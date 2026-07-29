CREATE TABLE "resource_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"file_storage_key" text NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_documents_file_storage_key_unique" UNIQUE("file_storage_key"),
	CONSTRAINT "resource_documents_entity_type_ck" CHECK ("resource_documents"."entity_type" IN ('driver', 'vehicle'))
);
--> statement-breakpoint
ALTER TABLE "resource_documents" ADD CONSTRAINT "resource_documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resource_documents_entity_idx" ON "resource_documents" USING btree ("entity_type","entity_id","created_at");