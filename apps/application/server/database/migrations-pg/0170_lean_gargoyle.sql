ALTER TABLE "projects" ADD COLUMN "ask_to_watch" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "continued_in_id" integer;