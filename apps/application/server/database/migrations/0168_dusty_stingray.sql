ALTER TABLE `projects` ADD `ask_to_watch` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `test_runs` ADD `continued_in_id` integer;