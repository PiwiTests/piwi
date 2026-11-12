CREATE TABLE `entity_link_dismissals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`failure_cluster_id` integer NOT NULL,
	`key` text NOT NULL,
	`external_id` text,
	`removed_by` integer,
	`removed_at` integer NOT NULL,
	FOREIGN KEY (`failure_cluster_id`) REFERENCES `failure_clusters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`removed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_entity_link_dismissals_cluster_key` ON `entity_link_dismissals` (`failure_cluster_id`,`key`);--> statement-breakpoint
CREATE INDEX `idx_entity_link_dismissals_removed_by` ON `entity_link_dismissals` (`removed_by`);--> statement-breakpoint
ALTER TABLE `failure_clusters` ADD `declared_issues_more` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_entity_links_cluster_declared_key` ON `entity_links` (`failure_cluster_id`,`key`) WHERE origin IN ('annotation', 'tag');