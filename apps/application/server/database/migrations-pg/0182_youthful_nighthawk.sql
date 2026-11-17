ALTER TABLE "projects" ADD COLUMN "run_variables" jsonb;--> statement-breakpoint
ALTER TABLE "run_targets" ADD COLUMN "features" jsonb;