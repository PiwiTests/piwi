ALTER TABLE `run_requests` ADD `run_id` integer;--> statement-breakpoint
ALTER TABLE `run_requests` ADD `run_token_digest` text;--> statement-breakpoint
ALTER TABLE `run_requests` ADD `run_token_expires_at` integer;--> statement-breakpoint
CREATE INDEX `idx_run_requests_run` ON `run_requests` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_run_requests_run_token` ON `run_requests` (`run_token_digest`);--> statement-breakpoint
ALTER TABLE `test_runs` ADD `requester_id` integer REFERENCES users(id);--> statement-breakpoint
CREATE INDEX `idx_test_runs_requester` ON `test_runs` (`requester_id`);