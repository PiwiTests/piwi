CREATE TABLE `coverage_daily` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`day` text NOT NULL,
	`branch` text DEFAULT '' NOT NULL,
	`suite` text NOT NULL,
	`commit_sha` text NOT NULL,
	`executable_lines` integer DEFAULT 0 NOT NULL,
	`executed_lines` integer DEFAULT 0 NOT NULL,
	`undetermined_lines` integer DEFAULT 0 NOT NULL,
	`known_functions` integer DEFAULT 0 NOT NULL,
	`run_functions` integer DEFAULT 0 NOT NULL,
	`files` integer DEFAULT 0 NOT NULL,
	`unit_only_lines` integer DEFAULT 0 NOT NULL,
	`e2e_only_lines` integer DEFAULT 0 NOT NULL,
	`both_lines` integer DEFAULT 0 NOT NULL,
	`computed_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_coverage_daily_unique` ON `coverage_daily` (`project_id`,`day`,`branch`,`suite`);--> statement-breakpoint
CREATE TABLE `coverage_totals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`commit_sha` text NOT NULL,
	`branch` text DEFAULT '' NOT NULL,
	`suite` text NOT NULL,
	`kind` text NOT NULL,
	`executable_lines` integer DEFAULT 0 NOT NULL,
	`executed_lines` integer DEFAULT 0 NOT NULL,
	`undetermined_lines` integer DEFAULT 0 NOT NULL,
	`known_functions` integer DEFAULT 0 NOT NULL,
	`run_functions` integer DEFAULT 0 NOT NULL,
	`files` integer DEFAULT 0 NOT NULL,
	`unit_only_lines` integer DEFAULT 0 NOT NULL,
	`e2e_only_lines` integer DEFAULT 0 NOT NULL,
	`both_lines` integer DEFAULT 0 NOT NULL,
	`files_without_data` integer,
	`files_carried_forward` integer DEFAULT 0 NOT NULL,
	`carried_from` text,
	`incomplete` integer DEFAULT false NOT NULL,
	`scope_version` integer DEFAULT 0 NOT NULL,
	`computed_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_coverage_totals_unique` ON `coverage_totals` (`project_id`,`commit_sha`,`suite`);--> statement-breakpoint
CREATE INDEX `idx_coverage_totals_project_branch` ON `coverage_totals` (`project_id`,`branch`,`computed_at`);