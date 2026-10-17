ALTER TABLE "coverage_totals" ADD COLUMN "detail_removed_at" timestamp;--> statement-breakpoint
ALTER TABLE "coverage_totals" ADD COLUMN "superseded_by" text;