CREATE TABLE `project_test_management` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`connection_id` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`dry_run` integer DEFAULT true NOT NULL,
	`provider_project_key` text NOT NULL,
	`key_sources` text,
	`run_scope` text,
	`run_policy` text,
	`statuses` text,
	`options` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `integration_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_test_management_project` ON `project_test_management` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_project_test_management_connection` ON `project_test_management` (`connection_id`);--> statement-breakpoint
CREATE TABLE `test_management_cases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`project_key` text NOT NULL,
	`key` text NOT NULL,
	`provider_id` text NOT NULL,
	`name` text NOT NULL,
	`status_name` text,
	`folder` text,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `integration_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_test_management_cases_key` ON `test_management_cases` (`connection_id`,`project_key`,`key`);