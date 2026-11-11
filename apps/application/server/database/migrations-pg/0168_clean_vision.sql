CREATE TABLE "project_test_management" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"connection_id" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"dry_run" boolean DEFAULT true NOT NULL,
	"provider_project_key" text NOT NULL,
	"key_sources" jsonb,
	"run_scope" jsonb,
	"run_policy" jsonb,
	"statuses" jsonb,
	"options" jsonb,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_management_cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"connection_id" integer NOT NULL,
	"project_key" text NOT NULL,
	"key" text NOT NULL,
	"provider_id" text NOT NULL,
	"name" text NOT NULL,
	"status_name" text,
	"folder" text,
	"fetched_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_test_management" ADD CONSTRAINT "project_test_management_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_test_management" ADD CONSTRAINT "project_test_management_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_management_cases" ADD CONSTRAINT "test_management_cases_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_test_management_project" ON "project_test_management" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_test_management_connection" ON "project_test_management" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_test_management_cases_key" ON "test_management_cases" USING btree ("connection_id","project_key","key");