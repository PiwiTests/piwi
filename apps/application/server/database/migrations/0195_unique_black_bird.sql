CREATE TABLE `shard_splits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`commit_sha` text NOT NULL,
	`shard_total` integer NOT NULL,
	`tests_hash` text NOT NULL,
	`split` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shard_splits_key` ON `shard_splits` (`project_id`,`commit_sha`,`shard_total`,`tests_hash`);