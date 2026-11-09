DROP INDEX `idx_trc_passed_retry`;--> statement-breakpoint
ALTER TABLE `test_runs_cases` ADD `passed_after_failure` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_trc_passed_after_failure` ON `test_runs_cases` (`test_run_id`) WHERE passed_after_failure = true;