CREATE TABLE "ci_dispatches" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"action_id" text,
	"action_name" text,
	"origin" text NOT NULL,
	"kind" text NOT NULL,
	"source_run_id" integer,
	"cluster_id" integer,
	"test_case_id" integer,
	"provider" text NOT NULL,
	"preset" text,
	"ref" text,
	"inputs" jsonb,
	"args" text NOT NULL,
	"files" jsonb,
	"tests" integer,
	"url" text,
	"provider_run_id" text,
	"state" text DEFAULT 'dispatched' NOT NULL,
	"detail" text,
	"run_id" integer,
	"by_user_id" integer,
	"by_name" text,
	"created_at" timestamp NOT NULL,
	"matched_at" timestamp,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ci_dispatches" ADD CONSTRAINT "ci_dispatches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_dispatches" ADD CONSTRAINT "ci_dispatches_cluster_id_failure_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."failure_clusters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_dispatches" ADD CONSTRAINT "ci_dispatches_test_case_id_test_cases_id_fk" FOREIGN KEY ("test_case_id") REFERENCES "public"."test_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_dispatches" ADD CONSTRAINT "ci_dispatches_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ci_dispatches_project" ON "ci_dispatches" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_ci_dispatches_project_state" ON "ci_dispatches" USING btree ("project_id","state");--> statement-breakpoint
CREATE INDEX "idx_ci_dispatches_cluster" ON "ci_dispatches" USING btree ("cluster_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_ci_dispatches_test_case" ON "ci_dispatches" USING btree ("test_case_id");--> statement-breakpoint
CREATE INDEX "idx_ci_dispatches_by_user" ON "ci_dispatches" USING btree ("by_user_id");--> statement-breakpoint
CREATE INDEX "idx_ci_dispatches_run" ON "ci_dispatches" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_ci_dispatches_provider_run" ON "ci_dispatches" USING btree ("provider_run_id");