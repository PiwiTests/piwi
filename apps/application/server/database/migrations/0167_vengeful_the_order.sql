CREATE TABLE `test_management_catalog_reads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`project_key` text NOT NULL,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `integration_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_test_management_catalog_reads_project` ON `test_management_catalog_reads` (`connection_id`,`project_key`);