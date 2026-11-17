CREATE TABLE `credential_projects` (
	`credential_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	PRIMARY KEY(`credential_id`, `project_id`),
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_credential_projects_project` ON `credential_projects` (`project_id`);--> statement-breakpoint
CREATE TABLE `credential_uses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`credential_id` integer,
	`credential_name` text NOT NULL,
	`feature` text NOT NULL,
	`project_id` integer,
	`user_id` integer,
	`api_key_id` integer,
	`subject_type` text,
	`subject_id` text,
	`destination` text,
	`result` text NOT NULL,
	`reason` text,
	`count` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_credential_uses_credential` ON `credential_uses` (`credential_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_credential_uses_project` ON `credential_uses` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_credential_uses_created` ON `credential_uses` (`created_at`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`service` text NOT NULL,
	`user_name` text,
	`destination` text NOT NULL,
	`secret` text,
	`all_projects` integer DEFAULT false NOT NULL,
	`allowed_inputs` text,
	`custom_requests` integer DEFAULT false NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`managed_by` text DEFAULT 'db' NOT NULL,
	`created_by` integer,
	`created_at` integer NOT NULL,
	`rotated_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_credentials_name` ON `credentials` (`name`);