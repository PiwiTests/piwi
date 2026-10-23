DROP INDEX `idx_test_runs_cases_run_browser`;--> statement-breakpoint
ALTER TABLE `test_runs_cases` ADD `repeat_each_index` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_test_runs_cases_run_browser` ON `test_runs_cases` (`test_run_id`,`test_case_id`,`repeat_each_index`,`retries`,`browser_name`);