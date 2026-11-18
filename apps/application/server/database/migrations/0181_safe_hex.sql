CREATE TABLE `environments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`key` text NOT NULL,
	`key_fold` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`aliases` text,
	`run_variables` text,
	`app_from_checkout` integer DEFAULT false NOT NULL,
	`protected` integer DEFAULT false NOT NULL,
	`required_tags` text,
	`env_file` text,
	`position` integer DEFAULT 0 NOT NULL,
	`discovered` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_environments_project_key` ON `environments` (`project_id`,`key_fold`);--> statement-breakpoint
ALTER TABLE `run_requests` ADD `environment_id` integer REFERENCES environments(id);--> statement-breakpoint
ALTER TABLE `test_runs` ADD `environment_id` integer REFERENCES environments(id);--> statement-breakpoint
CREATE INDEX `idx_test_runs_project_environment_start` ON `test_runs` (`project_id`,`environment_id`,`start_time`);