DROP INDEX "idx_coverage_totals_project_branch";--> statement-breakpoint
ALTER TABLE "coverage_daily" ADD COLUMN "commit_seen_at" timestamp;--> statement-breakpoint
ALTER TABLE "coverage_reports" ADD COLUMN "inventory_count" integer;--> statement-breakpoint
ALTER TABLE "coverage_totals" ADD COLUMN "commit_seen_at" timestamp;--> statement-breakpoint
ALTER TABLE "coverage_totals" ADD COLUMN "computation_started_at" timestamp;--> statement-breakpoint
CREATE INDEX "idx_coverage_totals_project_branch" ON "coverage_totals" USING btree ("project_id","branch","commit_seen_at");