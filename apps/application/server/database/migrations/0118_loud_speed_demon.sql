CREATE TABLE `coverage_executable` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`runtime` text NOT NULL,
	`path` text NOT NULL,
	`blob` text NOT NULL,
	`lines` text,
	`functions` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_coverage_executable_unique` ON `coverage_executable` (`project_id`,`runtime`,`path`,`blob`);--> statement-breakpoint
CREATE INDEX `idx_coverage_executable_project_path` ON `coverage_executable` (`project_id`,`path`);--> statement-breakpoint
CREATE TABLE `coverage_report_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`report_id` integer NOT NULL,
	`path` text NOT NULL,
	`fragment_id` integer NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `coverage_reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`fragment_id`) REFERENCES `coverage_fragments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_coverage_report_files_unique` ON `coverage_report_files` (`report_id`,`path`);--> statement-breakpoint
CREATE INDEX `idx_coverage_report_files_fragment` ON `coverage_report_files` (`fragment_id`);--> statement-breakpoint
CREATE TABLE `coverage_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`commit_sha` text NOT NULL,
	`branch` text DEFAULT '' NOT NULL,
	`suite` text NOT NULL,
	`kind` text NOT NULL,
	`tool` text,
	`incomplete` integer DEFAULT false NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`inventory_payload_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inventory_payload_id`) REFERENCES `case_payloads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_coverage_reports_unique` ON `coverage_reports` (`project_id`,`commit_sha`,`suite`);--> statement-breakpoint
CREATE INDEX `idx_coverage_reports_project_branch` ON `coverage_reports` (`project_id`,`branch`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_coverage_reports_inventory` ON `coverage_reports` (`inventory_payload_id`);--> statement-breakpoint
ALTER TABLE `coverage_fragments` ADD `executable` text;--> statement-breakpoint
ALTER TABLE `coverage_fragments` ADD `all_functions` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `coverage_scope` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `coverage_scope_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `test_runs` ADD `commit_sha` text;--> statement-breakpoint
CREATE INDEX `idx_test_runs_project_commit` ON `test_runs` (`project_id`,`commit_sha`);