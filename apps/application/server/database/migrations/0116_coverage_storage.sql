CREATE TABLE `coverage_fragments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`hash` text NOT NULL,
	`runtime` text NOT NULL,
	`path` text NOT NULL,
	`blob` text,
	`functions` text,
	`lines` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_coverage_fragments_project_hash` ON `coverage_fragments` (`project_id`,`hash`);--> statement-breakpoint
CREATE INDEX `idx_coverage_fragments_project_path` ON `coverage_fragments` (`project_id`,`path`);--> statement-breakpoint
CREATE TABLE `run_coverage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`runtime` text NOT NULL,
	`path` text NOT NULL,
	`blob` text,
	`functions` text,
	`lines` text,
	`executable` text,
	FOREIGN KEY (`run_id`) REFERENCES `test_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_run_coverage_unique` ON `run_coverage` (`run_id`,`runtime`,`path`);--> statement-breakpoint
CREATE TABLE `test_coverage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`test_case_id` integer NOT NULL,
	`branch` text DEFAULT '' NOT NULL,
	`runtime` text NOT NULL,
	`fragment_id` integer NOT NULL,
	`last_seen_run_id` integer,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`test_case_id`) REFERENCES `test_cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`fragment_id`) REFERENCES `coverage_fragments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`last_seen_run_id`) REFERENCES `test_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_test_coverage_unique` ON `test_coverage` (`test_case_id`,`branch`,`fragment_id`);--> statement-breakpoint
CREATE INDEX `idx_test_coverage_fragment` ON `test_coverage` (`fragment_id`);--> statement-breakpoint
CREATE INDEX `idx_test_coverage_project_branch` ON `test_coverage` (`project_id`,`branch`);--> statement-breakpoint
CREATE INDEX `idx_test_coverage_last_seen_run` ON `test_coverage` (`last_seen_run_id`);--> statement-breakpoint
DROP INDEX `idx_code_reach_unique`;--> statement-breakpoint
ALTER TABLE `code_reach` ADD `runtime` text DEFAULT 'browser' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_code_reach_unique` ON `code_reach` (`test_case_id`,`branch`,`runtime`,`file`);--> statement-breakpoint
ALTER TABLE `test_runs_cases` ADD `coverage_payload_id` integer REFERENCES case_payloads(id);--> statement-breakpoint
CREATE INDEX `idx_trc_coverage_payload` ON `test_runs_cases` (`coverage_payload_id`) WHERE coverage_payload_id IS NOT NULL;