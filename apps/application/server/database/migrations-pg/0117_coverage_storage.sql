CREATE TABLE "coverage_fragments" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"hash" text NOT NULL,
	"runtime" text NOT NULL,
	"path" text NOT NULL,
	"blob" text,
	"functions" text,
	"lines" text,
	"created_at" timestamp NOT NULL,
	"last_seen_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_coverage" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"runtime" text NOT NULL,
	"path" text NOT NULL,
	"blob" text,
	"functions" text,
	"lines" text,
	"executable" text
);
--> statement-breakpoint
CREATE TABLE "test_coverage" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"test_case_id" integer NOT NULL,
	"branch" text DEFAULT '' NOT NULL,
	"runtime" text NOT NULL,
	"fragment_id" integer NOT NULL,
	"last_seen_run_id" integer,
	"last_seen_at" timestamp NOT NULL
);
--> statement-breakpoint
DROP INDEX "idx_code_reach_unique";--> statement-breakpoint
ALTER TABLE "code_reach" ADD COLUMN "runtime" text DEFAULT 'browser' NOT NULL;--> statement-breakpoint
ALTER TABLE "test_runs_cases" ADD COLUMN "coverage_payload_id" integer;--> statement-breakpoint
ALTER TABLE "coverage_fragments" ADD CONSTRAINT "coverage_fragments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_coverage" ADD CONSTRAINT "run_coverage_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_coverage" ADD CONSTRAINT "test_coverage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_coverage" ADD CONSTRAINT "test_coverage_test_case_id_test_cases_id_fk" FOREIGN KEY ("test_case_id") REFERENCES "public"."test_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_coverage" ADD CONSTRAINT "test_coverage_fragment_id_coverage_fragments_id_fk" FOREIGN KEY ("fragment_id") REFERENCES "public"."coverage_fragments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_coverage" ADD CONSTRAINT "test_coverage_last_seen_run_id_test_runs_id_fk" FOREIGN KEY ("last_seen_run_id") REFERENCES "public"."test_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_coverage_fragments_project_hash" ON "coverage_fragments" USING btree ("project_id","hash");--> statement-breakpoint
CREATE INDEX "idx_coverage_fragments_project_path" ON "coverage_fragments" USING btree ("project_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_run_coverage_unique" ON "run_coverage" USING btree ("run_id","runtime","path");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_test_coverage_unique" ON "test_coverage" USING btree ("test_case_id","branch","fragment_id");--> statement-breakpoint
CREATE INDEX "idx_test_coverage_fragment" ON "test_coverage" USING btree ("fragment_id");--> statement-breakpoint
CREATE INDEX "idx_test_coverage_project_branch" ON "test_coverage" USING btree ("project_id","branch");--> statement-breakpoint
CREATE INDEX "idx_test_coverage_last_seen_run" ON "test_coverage" USING btree ("last_seen_run_id");--> statement-breakpoint
ALTER TABLE "test_runs_cases" ADD CONSTRAINT "test_runs_cases_coverage_payload_id_case_payloads_id_fk" FOREIGN KEY ("coverage_payload_id") REFERENCES "public"."case_payloads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_trc_coverage_payload" ON "test_runs_cases" USING btree ("coverage_payload_id") WHERE coverage_payload_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_code_reach_unique" ON "code_reach" USING btree ("test_case_id","branch","runtime","file");