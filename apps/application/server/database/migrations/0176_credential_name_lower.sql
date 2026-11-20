DROP INDEX `idx_credentials_name`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_credentials_name_lower` ON `credentials` (lower("name"));