CREATE TABLE "test_management_catalog_reads" (
	"id" serial PRIMARY KEY NOT NULL,
	"connection_id" integer NOT NULL,
	"project_key" text NOT NULL,
	"fetched_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "test_management_catalog_reads" ADD CONSTRAINT "test_management_catalog_reads_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_test_management_catalog_reads_project" ON "test_management_catalog_reads" USING btree ("connection_id","project_key");