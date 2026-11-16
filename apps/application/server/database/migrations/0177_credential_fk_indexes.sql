CREATE INDEX `idx_credential_uses_user` ON `credential_uses` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_credential_uses_api_key` ON `credential_uses` (`api_key_id`);--> statement-breakpoint
CREATE INDEX `idx_credentials_created_by` ON `credentials` (`created_by`);