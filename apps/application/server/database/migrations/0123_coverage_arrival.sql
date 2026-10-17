DROP INDEX `idx_coverage_totals_project_branch`;--> statement-breakpoint
ALTER TABLE `coverage_totals` ADD `commit_seen_at` integer;--> statement-breakpoint
ALTER TABLE `coverage_totals` ADD `computation_started_at` integer;--> statement-breakpoint
CREATE INDEX `idx_coverage_totals_project_branch` ON `coverage_totals` (`project_id`,`branch`,`commit_seen_at`);--> statement-breakpoint
ALTER TABLE `coverage_daily` ADD `commit_seen_at` integer;--> statement-breakpoint
ALTER TABLE `coverage_reports` ADD `inventory_count` integer;