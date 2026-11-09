CREATE TABLE `run_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`selection_key` text NOT NULL,
	`commit` text,
	`branch` text,
	`plan` text NOT NULL,
	`created_by` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_run_plans_project_expires` ON `run_plans` (`project_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_run_plans_created_by` ON `run_plans` (`created_by`);