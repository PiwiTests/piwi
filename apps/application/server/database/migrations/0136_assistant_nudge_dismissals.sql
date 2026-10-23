CREATE TABLE `assistant_nudge_dismissals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer,
	`nudge_id` text NOT NULL,
	`dismissed_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_assistant_nudge_dismissals_owner` ON `assistant_nudge_dismissals` (`owner_id`,`nudge_id`) WHERE owner_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_assistant_nudge_dismissals_shared` ON `assistant_nudge_dismissals` (`nudge_id`) WHERE owner_id IS NULL;