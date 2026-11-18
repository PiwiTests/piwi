ALTER TABLE `markers` ADD `environment_id` integer REFERENCES environments(id);--> statement-breakpoint
ALTER TABLE `markers` ADD `commit` text;--> statement-breakpoint
CREATE INDEX `idx_markers_environment` ON `markers` (`environment_id`);--> statement-breakpoint
ALTER TABLE `project_url_patterns` ADD `environment_id` integer REFERENCES environments(id);--> statement-breakpoint
CREATE INDEX `idx_project_url_patterns_environment` ON `project_url_patterns` (`environment_id`);--> statement-breakpoint
ALTER TABLE `projects` ADD `default_environment_id` integer REFERENCES environments(id);--> statement-breakpoint
CREATE INDEX `idx_projects_default_environment` ON `projects` (`default_environment_id`);