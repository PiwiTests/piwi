PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_scenario_gaps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`kind` text DEFAULT 'gap' NOT NULL,
	`detector` text NOT NULL,
	`class` text NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`evidence` text,
	`factors` text,
	`score` real,
	`ticket` text,
	`test_case_id` integer,
	`failure_cluster_id` integer,
	`test_run_id` integer,
	`pr_number` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`dismiss_reason` text,
	`assigned_to` text,
	`triaged_by` integer,
	`snoozed_until` integer,
	`snoozed_at_run_id` integer,
	`snoozed_at_signature` text,
	`accepted_at` integer,
	`covered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer,
	`closed_by_run_id` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`test_case_id`) REFERENCES `test_cases`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`failure_cluster_id`) REFERENCES `failure_clusters`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`triaged_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_scenario_gaps`("id", "project_id", "kind", "detector", "class", "key", "title", "evidence", "factors", "score", "ticket", "test_case_id", "failure_cluster_id", "test_run_id", "pr_number", "status", "dismiss_reason", "assigned_to", "triaged_by", "snoozed_until", "snoozed_at_run_id", "snoozed_at_signature", "accepted_at", "covered_at", "created_at", "updated_at", "closed_at", "closed_by_run_id") SELECT "id", "project_id", "kind", "detector", "class", "key", "title", "evidence", "factors", "score", "ticket", "test_case_id", "failure_cluster_id", "test_run_id", "pr_number", "status", "dismiss_reason", "assigned_to", "triaged_by", "snoozed_until", "snoozed_at_run_id", "snoozed_at_signature", "accepted_at", "covered_at", "created_at", "updated_at", "closed_at", "closed_by_run_id" FROM `scenario_gaps`;--> statement-breakpoint
DROP TABLE `scenario_gaps`;--> statement-breakpoint
ALTER TABLE `__new_scenario_gaps` RENAME TO `scenario_gaps`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_scenario_gaps_detector_key` ON `scenario_gaps` (`project_id`,`detector`,`key`);--> statement-breakpoint
CREATE INDEX `idx_scenario_gaps_project_status` ON `scenario_gaps` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_scenario_gaps_project_score` ON `scenario_gaps` (`project_id`,`score`);--> statement-breakpoint
CREATE INDEX `idx_scenario_gaps_pr` ON `scenario_gaps` (`project_id`,`pr_number`);--> statement-breakpoint
CREATE INDEX `idx_scenario_gaps_test_case` ON `scenario_gaps` (`test_case_id`);--> statement-breakpoint
CREATE INDEX `idx_scenario_gaps_cluster` ON `scenario_gaps` (`failure_cluster_id`);--> statement-breakpoint
CREATE INDEX `idx_scenario_gaps_triaged_by` ON `scenario_gaps` (`triaged_by`);--> statement-breakpoint
DROP INDEX `idx_markers_project_id`;--> statement-breakpoint
DROP INDEX `idx_test_cases_project_id`;--> statement-breakpoint
DROP INDEX `idx_test_runs_project_id`;--> statement-breakpoint
DROP INDEX `idx_test_runs_cases_test_run_id`;--> statement-breakpoint
ALTER TABLE `project_integrations` DROP COLUMN `space_id`;--> statement-breakpoint
ALTER TABLE `project_integrations` DROP COLUMN `parent_page_id`;