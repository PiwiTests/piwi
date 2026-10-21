ALTER TABLE `test_cases` ADD `external_id` text;--> statement-breakpoint
ALTER TABLE `test_cases` ADD `display_title` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_test_cases_external_id` ON `test_cases` (`project_id`,`external_id`) WHERE external_id IS NOT NULL;