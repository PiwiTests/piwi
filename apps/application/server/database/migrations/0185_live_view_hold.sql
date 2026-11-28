ALTER TABLE `projects` ADD `live_view_hold` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `live_view_hold_minutes` integer DEFAULT 5 NOT NULL;