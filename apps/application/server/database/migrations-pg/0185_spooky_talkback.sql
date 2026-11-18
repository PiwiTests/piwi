ALTER TABLE "markers" ADD COLUMN "environment_id" integer;--> statement-breakpoint
ALTER TABLE "markers" ADD COLUMN "commit" text;--> statement-breakpoint
ALTER TABLE "project_url_patterns" ADD COLUMN "environment_id" integer;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "default_environment_id" integer;--> statement-breakpoint
ALTER TABLE "markers" ADD CONSTRAINT "markers_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_url_patterns" ADD CONSTRAINT "project_url_patterns_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_default_environment_id_environments_id_fk" FOREIGN KEY ("default_environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_markers_environment" ON "markers" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "idx_project_url_patterns_environment" ON "project_url_patterns" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "idx_projects_default_environment" ON "projects" USING btree ("default_environment_id");