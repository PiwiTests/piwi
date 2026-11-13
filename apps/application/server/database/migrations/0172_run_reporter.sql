ALTER TABLE `test_runs` ADD `reporter_id` integer REFERENCES users(id);--> statement-breakpoint
CREATE INDEX `idx_test_runs_reporter` ON `test_runs` (`reporter_id`);