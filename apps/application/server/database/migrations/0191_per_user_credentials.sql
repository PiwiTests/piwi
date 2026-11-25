CREATE TABLE `credential_user_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`credential_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`remote_user` text NOT NULL,
	`secret` text NOT NULL,
	`state` text DEFAULT 'ready' NOT NULL,
	`created_at` integer NOT NULL,
	`tested_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_credential_user_tokens_credential_user` ON `credential_user_tokens` (`credential_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_credential_user_tokens_user` ON `credential_user_tokens` (`user_id`);--> statement-breakpoint
ALTER TABLE `credential_uses` ADD `remote_user` text;--> statement-breakpoint
ALTER TABLE `credentials` ADD `per_user` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `credentials` ADD `token_help_url` text;