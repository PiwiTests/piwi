CREATE TABLE "coverage_daily" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"day" text NOT NULL,
	"branch" text DEFAULT '' NOT NULL,
	"suite" text NOT NULL,
	"commit_sha" text NOT NULL,
	"executable_lines" integer DEFAULT 0 NOT NULL,
	"executed_lines" integer DEFAULT 0 NOT NULL,
	"undetermined_lines" integer DEFAULT 0 NOT NULL,
	"known_functions" integer DEFAULT 0 NOT NULL,
	"run_functions" integer DEFAULT 0 NOT NULL,
	"files" integer DEFAULT 0 NOT NULL,
	"unit_only_lines" integer DEFAULT 0 NOT NULL,
	"e2e_only_lines" integer DEFAULT 0 NOT NULL,
	"both_lines" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coverage_totals" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"commit_sha" text NOT NULL,
	"branch" text DEFAULT '' NOT NULL,
	"suite" text NOT NULL,
	"kind" text NOT NULL,
	"executable_lines" integer DEFAULT 0 NOT NULL,
	"executed_lines" integer DEFAULT 0 NOT NULL,
	"undetermined_lines" integer DEFAULT 0 NOT NULL,
	"known_functions" integer DEFAULT 0 NOT NULL,
	"run_functions" integer DEFAULT 0 NOT NULL,
	"files" integer DEFAULT 0 NOT NULL,
	"unit_only_lines" integer DEFAULT 0 NOT NULL,
	"e2e_only_lines" integer DEFAULT 0 NOT NULL,
	"both_lines" integer DEFAULT 0 NOT NULL,
	"files_without_data" integer,
	"files_carried_forward" integer DEFAULT 0 NOT NULL,
	"carried_from" text,
	"incomplete" boolean DEFAULT false NOT NULL,
	"scope_version" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coverage_daily" ADD CONSTRAINT "coverage_daily_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_totals" ADD CONSTRAINT "coverage_totals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_coverage_daily_unique" ON "coverage_daily" USING btree ("project_id","day","branch","suite");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_coverage_totals_unique" ON "coverage_totals" USING btree ("project_id","commit_sha","suite");--> statement-breakpoint
CREATE INDEX "idx_coverage_totals_project_branch" ON "coverage_totals" USING btree ("project_id","branch","computed_at");