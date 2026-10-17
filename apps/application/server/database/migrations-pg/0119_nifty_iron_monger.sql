CREATE TABLE "coverage_executable" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"runtime" text NOT NULL,
	"path" text NOT NULL,
	"blob" text NOT NULL,
	"lines" text,
	"functions" text,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coverage_report_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_id" integer NOT NULL,
	"path" text NOT NULL,
	"fragment_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coverage_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"commit_sha" text NOT NULL,
	"branch" text DEFAULT '' NOT NULL,
	"suite" text NOT NULL,
	"kind" text NOT NULL,
	"tool" text,
	"incomplete" boolean DEFAULT false NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"inventory_payload_id" integer,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coverage_fragments" ADD COLUMN "executable" text;--> statement-breakpoint
ALTER TABLE "coverage_fragments" ADD COLUMN "all_functions" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "coverage_scope" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "coverage_scope_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "commit_sha" text;--> statement-breakpoint
ALTER TABLE "coverage_executable" ADD CONSTRAINT "coverage_executable_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_report_files" ADD CONSTRAINT "coverage_report_files_report_id_coverage_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."coverage_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_report_files" ADD CONSTRAINT "coverage_report_files_fragment_id_coverage_fragments_id_fk" FOREIGN KEY ("fragment_id") REFERENCES "public"."coverage_fragments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_reports" ADD CONSTRAINT "coverage_reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_reports" ADD CONSTRAINT "coverage_reports_inventory_payload_id_case_payloads_id_fk" FOREIGN KEY ("inventory_payload_id") REFERENCES "public"."case_payloads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_coverage_executable_unique" ON "coverage_executable" USING btree ("project_id","runtime","path","blob");--> statement-breakpoint
CREATE INDEX "idx_coverage_executable_project_path" ON "coverage_executable" USING btree ("project_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_coverage_report_files_unique" ON "coverage_report_files" USING btree ("report_id","path");--> statement-breakpoint
CREATE INDEX "idx_coverage_report_files_fragment" ON "coverage_report_files" USING btree ("fragment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_coverage_reports_unique" ON "coverage_reports" USING btree ("project_id","commit_sha","suite");--> statement-breakpoint
CREATE INDEX "idx_coverage_reports_project_branch" ON "coverage_reports" USING btree ("project_id","branch","updated_at");--> statement-breakpoint
CREATE INDEX "idx_coverage_reports_inventory" ON "coverage_reports" USING btree ("inventory_payload_id");--> statement-breakpoint
CREATE INDEX "idx_test_runs_project_commit" ON "test_runs" USING btree ("project_id","commit_sha");