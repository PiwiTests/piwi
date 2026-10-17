DROP INDEX `idx_coverage_daily_unique`;--> statement-breakpoint
ALTER TABLE `coverage_daily` ADD `area` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_coverage_daily_unique` ON `coverage_daily` (`project_id`,`day`,`branch`,`suite`,`area`);--> statement-breakpoint
DROP INDEX `idx_coverage_totals_unique`;--> statement-breakpoint
ALTER TABLE `coverage_totals` ADD `area` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_coverage_totals_unique` ON `coverage_totals` (`project_id`,`commit_sha`,`suite`,`area`);--> statement-breakpoint
ALTER TABLE `projects` ADD `coverage_areas` text;