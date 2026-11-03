DROP INDEX "idx_trc_passed_retry";--> statement-breakpoint
ALTER TABLE "test_runs_cases" ADD COLUMN "passed_after_failure" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_trc_passed_after_failure" ON "test_runs_cases" USING btree ("test_run_id") WHERE passed_after_failure = true;