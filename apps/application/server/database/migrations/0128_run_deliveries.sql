CREATE TABLE `run_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`delivery_key` text NOT NULL,
	`run_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `test_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_run_deliveries_project_key` ON `run_deliveries` (`project_id`,`delivery_key`);--> statement-breakpoint
CREATE INDEX `idx_run_deliveries_run_id` ON `run_deliveries` (`run_id`);