ALTER TABLE "projects" ADD COLUMN "run_variables" jsonb;--> statement-breakpoint
ALTER TABLE "run_requests" ADD COLUMN "claim_features" jsonb;