DROP INDEX "idx_coverage_daily_unique";--> statement-breakpoint
DROP INDEX "idx_coverage_totals_unique";--> statement-breakpoint
ALTER TABLE "coverage_daily" ADD COLUMN "area" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "coverage_totals" ADD COLUMN "area" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "coverage_areas" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_coverage_daily_unique" ON "coverage_daily" USING btree ("project_id","day","branch","suite","area");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_coverage_totals_unique" ON "coverage_totals" USING btree ("project_id","commit_sha","suite","area");