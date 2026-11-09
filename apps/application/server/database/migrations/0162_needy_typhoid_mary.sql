CREATE TABLE `test_run_environment_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`kind` text NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`snapshot` text NOT NULL,
	`digest` text NOT NULL,
	`captured_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `test_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_test_run_environment_snapshots_run_kind_scope` ON `test_run_environment_snapshots` (`run_id`,`kind`,`scope`);