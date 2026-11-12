CREATE TABLE `reused_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`test_case_id` integer NOT NULL,
	`projects` text NOT NULL,
	`source_run_id` integer,
	`source_execution_ids` text NOT NULL,
	`source_commit` text NOT NULL,
	`plan_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `test_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`test_case_id`) REFERENCES `test_cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reused_results_run_case` ON `reused_results` (`run_id`,`test_case_id`);--> statement-breakpoint
CREATE INDEX `idx_reused_results_test_case` ON `reused_results` (`test_case_id`);--> statement-breakpoint
ALTER TABLE `test_runs` ADD `reused_count` integer DEFAULT 0 NOT NULL;