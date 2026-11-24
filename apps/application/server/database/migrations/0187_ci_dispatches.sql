CREATE TABLE `ci_dispatches` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` integer NOT NULL,
	`action_id` text,
	`action_name` text,
	`origin` text NOT NULL,
	`kind` text NOT NULL,
	`source_run_id` integer,
	`cluster_id` integer,
	`test_case_id` integer,
	`provider` text NOT NULL,
	`preset` text,
	`ref` text,
	`inputs` text,
	`args` text NOT NULL,
	`files` text,
	`tests` integer,
	`url` text,
	`provider_run_id` text,
	`state` text DEFAULT 'dispatched' NOT NULL,
	`detail` text,
	`run_id` integer,
	`by_user_id` integer,
	`by_name` text,
	`created_at` integer NOT NULL,
	`matched_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cluster_id`) REFERENCES `failure_clusters`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`test_case_id`) REFERENCES `test_cases`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_ci_dispatches_project` ON `ci_dispatches` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_ci_dispatches_project_state` ON `ci_dispatches` (`project_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_ci_dispatches_cluster` ON `ci_dispatches` (`cluster_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_ci_dispatches_test_case` ON `ci_dispatches` (`test_case_id`);--> statement-breakpoint
CREATE INDEX `idx_ci_dispatches_by_user` ON `ci_dispatches` (`by_user_id`);--> statement-breakpoint
CREATE INDEX `idx_ci_dispatches_run` ON `ci_dispatches` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_ci_dispatches_provider_run` ON `ci_dispatches` (`provider_run_id`);