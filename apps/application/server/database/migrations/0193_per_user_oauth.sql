CREATE TABLE `credential_authorizations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`state_hash` text NOT NULL,
	`credential_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`verifier` text NOT NULL,
	`return_to` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_credential_authorizations_state` ON `credential_authorizations` (`state_hash`);--> statement-breakpoint
CREATE INDEX `idx_credential_authorizations_expires` ON `credential_authorizations` (`expires_at`);--> statement-breakpoint
ALTER TABLE `credential_user_tokens` ADD `expires_at` integer;--> statement-breakpoint
ALTER TABLE `credentials` ADD `oauth_client_id` text;