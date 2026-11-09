CREATE TABLE `run_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` integer NOT NULL,
	`requester_id` integer NOT NULL,
	`target_id` integer,
	`kind` text NOT NULL,
	`tests` text NOT NULL,
	`options` text NOT NULL,
	`source` text NOT NULL,
	`state` text DEFAULT 'waiting' NOT NULL,
	`outcome` text,
	`detail` text,
	`stop_requested_at` integer,
	`expires_at` integer NOT NULL,
	`claimed_at` integer,
	`answered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requester_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `run_targets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_run_requests_requester` ON `run_requests` (`requester_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_run_requests_target` ON `run_requests` (`target_id`);--> statement-breakpoint
CREATE INDEX `idx_run_requests_project` ON `run_requests` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_run_requests_state` ON `run_requests` (`state`,`expires_at`);--> statement-breakpoint
CREATE TABLE `run_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`api_key_id` integer NOT NULL,
	`kind` text NOT NULL,
	`device_name` text NOT NULL,
	`platform` text,
	`version` text,
	`project_ids` text,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_run_targets_api_key` ON `run_targets` (`api_key_id`);--> statement-breakpoint
CREATE INDEX `idx_run_targets_user` ON `run_targets` (`user_id`);--> statement-breakpoint
ALTER TABLE `api_keys` ADD `client_kind` text;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `permissions` text;--> statement-breakpoint
ALTER TABLE `extension_device_codes` ADD `client_kind` text;