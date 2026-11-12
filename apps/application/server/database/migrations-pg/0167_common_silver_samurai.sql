CREATE TABLE "reused_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"test_case_id" integer NOT NULL,
	"projects" jsonb NOT NULL,
	"source_run_id" integer,
	"source_execution_ids" jsonb NOT NULL,
	"source_commit" text NOT NULL,
	"plan_id" integer NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "reused_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reused_results" ADD CONSTRAINT "reused_results_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reused_results" ADD CONSTRAINT "reused_results_test_case_id_test_cases_id_fk" FOREIGN KEY ("test_case_id") REFERENCES "public"."test_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_reused_results_run_case" ON "reused_results" USING btree ("run_id","test_case_id");--> statement-breakpoint
CREATE INDEX "idx_reused_results_test_case" ON "reused_results" USING btree ("test_case_id");