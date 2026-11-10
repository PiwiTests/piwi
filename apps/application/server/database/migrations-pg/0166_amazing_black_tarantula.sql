CREATE TABLE "run_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"selection_key" text NOT NULL,
	"commit" text,
	"branch" text,
	"plan" jsonb NOT NULL,
	"created_by" integer,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_plans" ADD CONSTRAINT "run_plans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_plans" ADD CONSTRAINT "run_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_run_plans_project_expires" ON "run_plans" USING btree ("project_id","expires_at");--> statement-breakpoint
CREATE INDEX "idx_run_plans_created_by" ON "run_plans" USING btree ("created_by");