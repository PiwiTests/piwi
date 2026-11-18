CREATE TABLE "environments" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"key" text NOT NULL,
	"key_fold" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"aliases" jsonb,
	"run_variables" jsonb,
	"app_from_checkout" boolean DEFAULT false NOT NULL,
	"protected" boolean DEFAULT false NOT NULL,
	"required_tags" jsonb,
	"env_file" text,
	"position" integer DEFAULT 0 NOT NULL,
	"discovered" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_requests" ADD COLUMN "environment_id" integer;--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "environment_id" integer;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_environments_project_key" ON "environments" USING btree ("project_id","key_fold");--> statement-breakpoint
ALTER TABLE "run_requests" ADD CONSTRAINT "run_requests_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_test_runs_project_environment_start" ON "test_runs" USING btree ("project_id","environment_id","start_time");